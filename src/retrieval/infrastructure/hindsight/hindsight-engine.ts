import { createHash } from "node:crypto";
import { createClient, createConfig, HindsightClient, HindsightError, sdk, type RecallResult } from "@vectorize-io/hindsight-client";
import type { BankId, EpisodeId, FactId, Scope } from "../../../shared-kernel/index.js";
import type { Episode, Fact } from "../../../memory/index.js";
import type { RankedHit, RecallOptions, RetrievalEngine } from "../../ports/retrieval-engine.js";

/**
 * Hindsight (vectorize-io/hindsight 1.1.0) behind the RetrievalEngine port, spike arm C.
 * Anti-corruption layer over the official TypeScript client (`@vectorize-io/hindsight-client`).
 *
 * Mapping (see research_notes/hindsight-2026-10-23.md for what the API does and does not offer):
 * - Our Bank -> Hindsight bank `<prefix><bankId>`, created with `retain_extraction_mode: verbatim`
 *   and observations off, so a Fact statement is stored as-is instead of being re-extracted (the
 *   port indexes facts our own extraction already produced). Verbatim mode still makes one small
 *   LLM call per retain for entities and dates; there is no LLM-free write path.
 * - Our ids travel in Hindsight's `metadata` (string -> string) and `document_id` (`fact:<id>` /
 *   `episode:<id>`), and come back on every recall result, so hits carry OUR ids.
 * - Validity (`validFrom` / `validTo`) is metadata too: Hindsight has no as-of filter (its
 *   `temporal_window` ranks, it does not filter), so point-in-time recall over-fetches and filters
 *   here. `retractFact` soft-retires the memory with `PATCH state=invalidated` (there is no hard
 *   delete of a single memory; recall excludes invalidated units). A re-index (supersession changes
 *   validity, text unchanged) writes a new document `fact:<id>:<version>` first and deletes the older
 *   versions after, because a re-retain of identical text under the same document id is skipped by
 *   content hash, and delete-then-retain would leave the fact unrecallable if the retain failed.
 *   Recall keeps the newest version per id (metadata `indexedAt`).
 * - `purgeBank` deletes the whole Hindsight bank (hard delete) and re-counts; a missing bank counts
 *   as zero. Zero is what the API reports; the research note records what a direct look at
 *   Hindsight's Postgres showed for deleted banks.
 * - `retractFact` invalidates the fact's document in the fact's own bank only.
 */
export interface HindsightEngineOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  /** Prefix for Hindsight bank ids, so several deployments (or the tests) can share one server. */
  readonly bankPrefix?: string;
  /** Token budget handed to recall before filtering; Hindsight has no result-count limit. Doubled for point-in-time recall. */
  readonly recallMaxTokens?: number;
  /** Per call; a hung engine must not block the outbox relay forever. */
  readonly timeoutMs?: number;
}

const FACT = "fact";
const EPISODE = "episode";

export class HindsightEngine implements RetrievalEngine {
  readonly name = "hindsight";
  private readonly client: HindsightClient;
  private readonly raw: ReturnType<typeof createClient>;
  private readonly prefix: string;
  private readonly recallMaxTokens: number;
  private readonly timeoutMs: number;

  constructor(options: HindsightEngineOptions) {
    const baseUrl = options.baseUrl.replace(/\/$/, "");
    this.client = new HindsightClient({ baseUrl, ...(options.apiKey ? { apiKey: options.apiKey } : {}) });
    this.raw = createClient(createConfig({ baseUrl, ...(options.apiKey ? { headers: { Authorization: `Bearer ${options.apiKey}` } } : {}) }));
    this.prefix = options.bankPrefix ?? "mem-";
    this.recallMaxTokens = options.recallMaxTokens ?? 8_192;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.timeoutMs);
  }

  private hsBank(bankId: BankId): string {
    return `${this.prefix}${bankId}`;
  }

  /** PUT is create-or-update: one cheap call per index keeps the bank's configuration right even after another process purged it (a retain into a missing bank would auto-create it with the default, extracting mode). */
  private async ensureBank(hs: string): Promise<void> {
    await this.client.createBank(hs, { retainExtractionMode: "verbatim", enableObservations: false, signal: this.signal() });
  }

  async indexFact(fact: Fact): Promise<void> {
    const metadata: Record<string, string> = {
      refId: fact.id,
      kind: FACT,
      validFrom: fact.validity.validFrom.toISOString(),
      retracted: String(fact.transaction.retractedAt !== undefined),
    };
    if (fact.validity.validTo) metadata.validTo = fact.validity.validTo.toISOString();
    await this.put(fact.bankId, FACT, fact.id, fact.statement, fact.validity.validFrom, metadata);
    if (fact.transaction.retractedAt !== undefined) await this.invalidateDocument(this.hsBank(fact.bankId), FACT, fact.id);
  }

  async indexEpisode(episode: Episode): Promise<void> {
    const metadata: Record<string, string> = { refId: episode.id, kind: EPISODE, validFrom: episode.occurredAt.toISOString(), retracted: "false" };
    if (episode.role) metadata.role = episode.role;
    await this.put(episode.bankId, EPISODE, episode.id, episode.text, episode.occurredAt, metadata);
  }

  /**
   * One document per version of a fact/episode: `<kind>:<id>:<version>` where the version hashes the
   * metadata, so an unchanged re-index (outbox redelivery, supersession re-indexing the new fact)
   * stores nothing, a changed one is written before the older versions are deleted, and a failed
   * retain leaves the old version recallable for the outbox to retry.
   */
  private async put(bankId: BankId, kind: string, refId: string, content: string, timestamp: Date, metadata: Record<string, string>): Promise<void> {
    const hs = this.hsBank(bankId);
    const version = createHash("sha256").update(JSON.stringify(metadata)).digest("hex").slice(0, 12);
    const documentId = `${kind}:${refId}:${version}`;
    await this.ensureBank(hs);
    const existing = await this.versionsOf(hs, kind, refId);
    // Redelivery or an unchanged re-index: the version is already stored. Retaining it again would be
    // skipped by content hash after `replace` had dropped its units (measured), so leave it alone.
    if (!existing.includes(documentId)) {
      await this.client.retain(hs, content, { documentId, timestamp, metadata: { ...metadata, indexedAt: new Date().toISOString() }, updateMode: "replace", signal: this.signal() });
    }
    for (const old of existing) if (old !== documentId) await this.deleteDocument(hs, old);
  }

  /** Document ids of every stored version of a fact/episode (the `q` search is a prefix/substring match; the result is filtered exactly). */
  private async versionsOf(hs: string, kind: string, refId: string): Promise<string[]> {
    const prefix = `${kind}:${refId}:`;
    const out = new Set<string>();
    for (let offset = 0; ; offset += 100) {
      const r = await sdk.listDocuments({ client: this.raw, path: { bank_id: hs }, query: { q: prefix, limit: 100, offset }, signal: this.signal() });
      if (r.error || !r.data) {
        if (status(r) === 404) return [];
        throw new HindsightError(`list documents in ${hs}: HTTP ${status(r)}`, status(r), r.error);
      }
      for (const d of r.data.items) if (d.id.startsWith(prefix)) out.add(d.id);
      if (r.data.items.length < 100) break;
    }
    return [...out];
  }

  private async deleteDocument(hs: string, documentId: string): Promise<void> {
    const r = await sdk.deleteDocument({ client: this.raw, path: { bank_id: hs, document_id: documentId }, signal: this.signal() });
    if (r.error && status(r) !== 404) throw new HindsightError(`delete document ${documentId} in ${hs}: HTTP ${status(r)}`, status(r), r.error);
  }

  /** Soft-retire every valid unit of every version of a document; a bank or document that vanished meanwhile has nothing to invalidate. */
  private async invalidateDocument(hs: string, kind: string, refId: string): Promise<void> {
    let versions: string[];
    try {
      versions = await this.versionsOf(hs, kind, refId);
    } catch (e) {
      if (isNotFound(e)) return;
      throw e;
    }
    for (const documentId of versions) {
      let list;
      try {
        list = await this.client.listMemories(hs, { documentId, state: "valid", limit: 100, signal: this.signal() });
      } catch (e) {
        if (isNotFound(e)) continue;
        throw e;
      }
      for (const unit of list.items) {
        const r = await sdk.updateMemory({ client: this.raw, path: { bank_id: hs, memory_id: unit.id }, body: { state: "invalidated", reason: "retracted by mem" }, signal: this.signal() });
        if (r.error && status(r) !== 404) throw new HindsightError(`invalidate memory ${unit.id} in ${hs}: HTTP ${status(r)}`, status(r), r.error);
      }
    }
  }

  async retractFact(bankId: BankId, factId: FactId): Promise<void> {
    await this.invalidateDocument(this.hsBank(bankId), FACT, factId);
  }

  async recall(scope: Scope, query: string, options: RecallOptions): Promise<readonly RankedHit[]> {
    const hs = this.hsBank(scope.bankId);
    let results: RecallResult[];
    try {
      const r = await this.client.recall(hs, query, {
        types: ["world", "experience"],
        // A past asOf or many retracted facts means more of the budget is filtered away afterwards; there is no server-side filter to push down.
        maxTokens: options.asOf ? this.recallMaxTokens * 2 : this.recallMaxTokens,
        includeEntities: false,
        ...(options.asOf ? { queryTimestamp: options.asOf.toISOString() } : {}),
        signal: this.signal(),
      });
      results = r.results;
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    const asOf = (options.asOf ?? new Date()).getTime();
    const kinds = new Set(options.includeEpisodes ? [FACT, EPISODE] : [FACT]);
    // Several versions of one fact can coexist briefly (see put); the newest one is the truth.
    const newest = new Map<string, { result: RecallResult; indexedAt: number }>();
    const order: string[] = [];
    for (const r of results) {
      const m = r.metadata ?? {};
      if (!m.refId || !m.kind || !kinds.has(m.kind)) continue;
      const key = `${m.kind}:${m.refId}`;
      const indexedAt = m.indexedAt ? Date.parse(m.indexedAt) : 0;
      const seen = newest.get(key);
      if (!seen) order.push(key);
      if (!seen || indexedAt > seen.indexedAt) newest.set(key, { result: r, indexedAt });
    }
    const hits: RankedHit[] = [];
    for (const key of order) {
      const { result: r } = newest.get(key) as { result: RecallResult; indexedAt: number };
      const m = r.metadata ?? {};
      if (m.retracted === "true") continue;
      const from = m.validFrom ? Date.parse(m.validFrom) : Number.NEGATIVE_INFINITY;
      const to = m.validTo ? Date.parse(m.validTo) : Number.POSITIVE_INFINITY;
      if (!(from <= asOf && asOf < to)) continue;
      const score = r.scores?.final ?? 0;
      hits.push(m.kind === FACT ? { factId: m.refId as FactId, score } : { episodeId: m.refId as EpisodeId, score });
      if (hits.length >= options.limit) break;
    }
    return hits;
  }

  async countBank(bankId: BankId): Promise<number> {
    try {
      const list = await this.client.listMemories(this.hsBank(bankId), { limit: 1, signal: this.signal() });
      return list.total;
    } catch (e) {
      if (isNotFound(e)) return 0;
      throw e;
    }
  }

  async purgeBank(bankId: BankId): Promise<{ readonly deleted: number; readonly remaining: number }> {
    const hs = this.hsBank(bankId);
    const before = await this.countBank(bankId);
    const r = await sdk.deleteBank({ client: this.raw, path: { bank_id: hs }, signal: this.signal() });
    if (r.error && status(r) !== 404) throw new HindsightError(`delete bank ${hs}: HTTP ${status(r)}`, status(r), r.error);
    return { deleted: before, remaining: await this.countBank(bankId) };
  }

  async rebuild(bankId: BankId, facts: AsyncIterable<Fact>, episodes: AsyncIterable<Episode>): Promise<void> {
    const purged = await this.purgeBank(bankId);
    if (purged.remaining > 0) throw new Error(`hindsight: ${purged.remaining} memories remain in ${this.hsBank(bankId)} after purge; refusing to rebuild on top`);
    for await (const f of facts) await this.indexFact(f);
    for await (const e of episodes) await this.indexEpisode(e);
  }
}

function status(r: { response?: { status?: number } }): number | undefined {
  return r.response?.status;
}

function isNotFound(e: unknown): boolean {
  return e instanceof HindsightError && e.statusCode === 404;
}
