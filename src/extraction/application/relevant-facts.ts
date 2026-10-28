import type { Scope } from "../../shared-kernel/index.js";
import type { Episode, Fact } from "../../memory/index.js";
import type { RetrievalEngine } from "../../retrieval/index.js";
import type { CandidateFactSelector } from "../ports/candidate-facts.js";

export interface RelevanceCandidateSelectorOptions {
  /** Current facts taken by the engine's similarity to the episode text. */
  readonly topK?: number;
  /** Most recently recorded current facts always considered (they may not be in the engine's index yet). */
  readonly recentFacts?: number;
  /** Upper bound on the selection; the cut is by rank (similarity, then context-episode facts, recent, entity matches), not by date. Default 3k. */
  readonly maxCandidates?: number;
  /** Episode text sent to the embedder and scanned for entities is cut here. */
  readonly maxQueryChars?: number;
  readonly warn?: (message: string) => void;
}

/**
 * Candidate facts for an episode: a ranked union of cheap sets over the bank's current facts,
 * cut at `maxCandidates` by rank and shown in the bank's order (validFrom ascending).
 *
 *  1. the engine's top-k by similarity to the episode (one embedding call). A short trigger ("No,
 *     Porto now") is queried together with the end of the preceding turn, which carries its topic;
 *  2. facts extracted from the trigger's context episodes, newest first, at most k, and the most
 *     recently recorded facts: the worker drains queued episodes back to back while the outbox
 *     relay indexes new facts on its own ticks, so the facts most likely to be duplicated or
 *     superseded by the next episode are the ones the engine cannot return yet;
 *  3. facts whose statement names something the trigger or the preceding turn mentions: entities
 *     (capitalized tokens, minus sentence starters, boilerplate and short all-caps acronyms) come from
 *     the fact statement, which the model writes with reliable capitalization, and are looked up
 *     case- and accent-insensitively in the episode's token set, so "i moved to lisbon" reaches the
 *     Lisbon fact; ranked by shared entities, then newest, at most 2k;
 *  4. when the engine fails, or returns no current fact although the bank has more than k (index
 *     not built, embedder changed, index lagging), the k newest facts by validity, with one warning.
 *
 * When the bank has no more current facts than k, every fact is shown and no embedding call is made.
 */
export class RelevanceCandidateSelector implements CandidateFactSelector {
  private readonly topK: number;
  private readonly recentFacts: number;
  private readonly maxCandidates: number;
  private readonly maxQueryChars: number;
  private readonly warn: (message: string) => void;

  constructor(
    private readonly engine: RetrievalEngine,
    opts: RelevanceCandidateSelectorOptions = {},
  ) {
    this.topK = opts.topK ?? 20;
    this.recentFacts = opts.recentFacts ?? 5;
    this.maxCandidates = opts.maxCandidates ?? 3 * this.topK;
    this.maxQueryChars = opts.maxQueryChars ?? 8_000;
    this.warn = opts.warn ?? ((m) => console.warn(m));
    if (!Number.isInteger(this.topK) || this.topK < 1) throw new Error(`topK must be a positive integer, got ${String(opts.topK)}`);
  }

  async select(scope: Scope, trigger: Episode, recent: readonly Episode[], current: readonly Fact[]): Promise<readonly Fact[]> {
    if (current.length <= this.topK) return current;
    const byId = new Map(current.map((f) => [f.id as string, f]));
    const ranked: string[] = [];
    const take = (id: string) => {
      if (byId.has(id) && !ranked.includes(id)) ranked.push(id);
    };
    const newestFirst = (a: Fact, b: Fact) => b.transaction.recordedAt.getTime() - a.transaction.recordedAt.getTime();
    const previous = recent.at(-1);
    const episodeText = `${previous ? `${previous.text.slice(-1_000)}\n` : ""}${trigger.text}`;

    // 1. Similarity (over-fetch so hits on facts that are no longer current do not crowd out live ones).
    const query = trigger.text.length < 200 && previous ? episodeText : trigger.text;
    let hits: string[] = [];
    let failed = false;
    try {
      hits = (await this.engine.recall(scope, query.slice(0, this.maxQueryChars), { limit: 2 * this.topK, includeEpisodes: false }))
        .flatMap((h) => (h.factId && byId.has(h.factId) ? [h.factId as string] : []))
        .slice(0, this.topK);
    } catch (e) {
      failed = true;
      this.warn(`candidate facts: engine recall failed for bank ${scope.bankId} (${e instanceof Error ? e.message : String(e)}); showing the newest facts instead`);
    }
    if (hits.length === 0) {
      if (!failed) this.warn(`candidate facts: engine returned no current fact for bank ${scope.bankId} although it has ${current.length}; is the index built for this embedder?`);
      hits = current.slice(-this.topK).map((f) => f.id as string);
    }
    hits.forEach(take);

    // 2. Facts from the context episodes, and the newest facts.
    const contextIds = new Set<string>([trigger.id, ...recent.map((e) => e.id)]);
    current
      .filter((f) => f.provenance.triggerEpisodeId !== undefined && contextIds.has(f.provenance.triggerEpisodeId))
      .sort(newestFirst)
      .slice(0, this.topK)
      .forEach((f) => take(f.id));
    [...current].sort(newestFirst).slice(0, this.recentFacts).forEach((f) => take(f.id));

    // 3. Shared entities with the trigger and the preceding turn.
    const tokens = tokenSet(episodeText.slice(0, this.maxQueryChars + 1_000));
    current
      .filter((f) => !ranked.includes(f.id))
      .map((f) => ({ f, shared: sharedEntities(f.statement, tokens) }))
      .filter((x) => x.shared > 0)
      .sort((a, b) => b.shared - a.shared || newestFirst(a.f, b.f))
      .slice(0, 2 * this.topK)
      .forEach((x) => take(x.f.id));

    const kept = new Set(ranked.slice(0, this.maxCandidates));
    return current.filter((f) => kept.has(f.id));
  }
}

/**
 * Capitalized tokens of three or more letters, minus sentence starters, the boilerplate every
 * statement carries ("The Subject") and short all-caps tokens (JSON, API, USD) that name technology
 * rather than a person or place. Cheap and language-naive on purpose: a false positive adds one
 * fact to the prompt, a false negative is what the similarity step is for.
 */
const STOP = new Set(
  "The This That These Those There Then They Them Their And But Also Yes Yeah Yep Nope Not Now Just Okay Hi Hey Hello Thanks Thank Please Sorry Well What When Where Which Who Why How Did Does Was Were Will Would Could Should Can May Might Must Have Has Had Here Our Ours Your Yours His Her Its My Mine You Are Let Like Maybe Anyway Actually Honestly Today Tomorrow Yesterday Subject"
    .split(" "),
);
const ENTITY = /(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{M}\p{N}'’-]{2,}/gu;
const TOKEN = /[\p{L}\p{M}\p{N}'’-]+/gu;
/** "Mina's" and "Mina" are the same entity; a contraction ("I'm", "We've") is not one; a trailing hyphen or apostrophe is punctuation. */
const normalize = (word: string): string => word.replace(/['’](s|m|re|ve|ll|d)$/u, "").replace(/['’-]+$/u, "");
/** Lowercase without diacritics, so "ΑΘΗΝΑ", "αθηνα" and "Αθήνα" are one key. */
const fold = (word: string): string => word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function namedEntities(text: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(ENTITY)) {
    const word = normalize(m[0]);
    if (word.length < 3 || STOP.has(word)) continue;
    if (word.length <= 4 && word === word.toUpperCase()) continue;
    out.add(word);
  }
  return out;
}

/** The episode's words, folded, with hyphenated words also split into their parts. Built once per episode: lookups are linear in the bank. */
export function tokenSet(text: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(TOKEN)) {
    const word = fold(normalize(m[0]));
    if (word === "") continue;
    out.add(word);
    if (word.includes("-")) for (const part of word.split("-")) if (part !== "") out.add(part);
  }
  return out;
}

/** How many of the statement's entities appear among the episode's tokens. */
export function sharedEntities(statement: string, episodeTokens: ReadonlySet<string>): number {
  let n = 0;
  for (const entity of namedEntities(statement)) if (episodeTokens.has(fold(entity))) n++;
  return n;
}
