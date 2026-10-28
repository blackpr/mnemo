import { Honcho, type Message, type Session } from "@honcho-ai/sdk";
import { z } from "zod";
import type { BankId, EpisodeId, FactId, Scope } from "../../../shared-kernel/index.js";
import type { Episode, Fact } from "../../../memory/index.js";
import type { RankedHit, RecallOptions, RetrievalEngine } from "../../ports/retrieval-engine.js";

/**
 * Honcho (plastic-labs/honcho 3.4.1) behind the RetrievalEngine port, spike arm D.
 * Anti-corruption layer over the official TypeScript SDK (`@honcho-ai/sdk`).
 *
 * Mapping (see research_notes/honcho-2026-10-23.md):
 * - Our Bank -> Honcho workspace `<prefix><bankId>` with one peer (`subject`) and two sessions,
 *   `facts` and `episodes`. The peer and both sessions are configured `observe_me: false`, so the
 *   deriver does not re-extract what our own extraction already produced: behind this port Honcho is
 *   its message store plus embedding search (semantic + keyword, RRF-fused). Honcho's own pipeline
 *   (deriver conclusions, representation, dialectic chat) is exercised natively by arm D, not here.
 * - A Fact or Episode is one message whose metadata carries our id, kind, validity and retraction
 *   flag; `created_at` is our validFrom / occurredAt. Search returns the metadata, so hits carry OUR
 *   ids. Messages cannot be deleted one by one: `retractFact` flips the metadata flag and recall
 *   filters it out. There is no as-of filter either; recall pushes what Honcho's filter grammar can
 *   take into the search (`metadata.retracted`, `created_at <= asOf`, i.e. validFrom) and filters
 *   `validTo` here, over-fetching up to Honcho's limit of 100. Search exposes an order, not a score:
 *   hits get 1/rank.
 * - `purgeBank` deletes the sessions and then the workspace. Honcho deletes asynchronously (202 and
 *   a deriver queue job), so the purge polls until its API reports nothing left, up to
 *   `purgeTimeoutMs`, and `remaining` is whatever the API still reports after that. Honcho keeps
 *   listing the workspace until the job has run (checked against its Postgres: messages, embeddings,
 *   sessions, workspace and queue rows were all gone the moment the API stopped listing it), so a
 *   stopped deriver shows up as a purge timeout, not as a false zero.
 * - Sessions are created with summaries off, so the deriver schedules no LLM work for them at all.
 * - `retractFact` flags the message in the fact's own workspace only.
 */
export interface HonchoEngineOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly workspacePrefix?: string;
  readonly purgeTimeoutMs?: number;
  /** How long an index call waits for Honcho's background embedding to make the message searchable. */
  readonly searchableTimeoutMs?: number;
}

const PEER = "subject";
const FACTS = "facts";
const EPISODES = "episodes";
const SEARCH_MAX = 100;

/** The two read endpoints the adapter must call without the SDK's get-or-create side effect (counting and purging must never re-create a workspace). */
const pageSchema = z.object({ items: z.array(z.object({ id: z.string() })), total: z.number().int().nonnegative(), pages: z.number().int().nonnegative() });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function retryOnConflict<T>(op: () => Promise<T>, attempts = 10): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await op();
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status !== 409 || i >= attempts) throw e;
      await sleep(500 * i);
    }
  }
}

export class HonchoEngine implements RetrievalEngine {
  readonly name = "honcho";
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly prefix: string;
  private readonly purgeTimeoutMs: number;
  private readonly searchableTimeoutMs: number;
  /** Workspaces this process has already provisioned (peer + sessions); cleared on purge. */
  private readonly provisioned = new Map<string, Promise<{ facts: Session; episodes: Session }>>();

  constructor(options: HonchoEngineOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.prefix = options.workspacePrefix ?? "mem-";
    this.purgeTimeoutMs = options.purgeTimeoutMs ?? 60_000;
    this.searchableTimeoutMs = options.searchableTimeoutMs ?? 15_000;
  }

  private workspace(bankId: BankId): string {
    return `${this.prefix}${bankId}`;
  }

  /** A client bound to one workspace. Constructing it does not touch the server. */
  private clientFor(workspaceId: string): Honcho {
    return new Honcho({ baseURL: this.baseUrl, workspaceId, ...(this.apiKey ? { apiKey: this.apiKey } : {}) });
  }

  /** `POST .../list` reads straight over HTTP: the SDK's `sessions()` and `session()` get-or-create the workspace first, which a count or a purge poll must not do. Returns null for a missing workspace or session. */
  private async listRaw(route: string, page: number): Promise<z.infer<typeof pageSchema> | null> {
    const res = await fetch(`${this.baseUrl}/v3/workspaces/${route}?page=${page}&size=100`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: "{}",
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`honcho ${route}: HTTP ${res.status}`);
    return pageSchema.parse(await res.json());
  }

  /** Session ids of a workspace without creating anything; empty when the workspace does not exist. */
  private async sessionIds(ws: string): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; ; page++) {
      const p = await this.listRaw(`${encodeURIComponent(ws)}/sessions/list`, page);
      if (!p) return out;
      out.push(...p.items.map((i) => i.id));
      if (page >= p.pages) return out;
    }
  }

  private async messageCount(ws: string, sessionId: string): Promise<number> {
    const p = await this.listRaw(`${encodeURIComponent(ws)}/sessions/${encodeURIComponent(sessionId)}/messages/list`, 1);
    return p?.total ?? 0;
  }

  private sessions(bankId: BankId): Promise<{ facts: Session; episodes: Session }> {
    const ws = this.workspace(bankId);
    let p = this.provisioned.get(ws);
    if (!p) {
      p = (async () => {
        const honcho = this.clientFor(ws);
        // Right after a purge Honcho can still answer 409 for the peer while its deletion job settles; retry briefly.
        await retryOnConflict(() => honcho.peer(PEER, { configuration: { observeMe: false } }));
        const peers = [[PEER, { observeMe: false, observeOthers: false }] as [string, { observeMe: boolean; observeOthers: boolean }]];
        const configuration = { summary: { enabled: false } };
        const facts = await retryOnConflict(() => honcho.session(FACTS, { peers, configuration }));
        const episodes = await retryOnConflict(() => honcho.session(EPISODES, { peers, configuration }));
        return { facts, episodes };
      })();
      p.catch(() => this.provisioned.delete(ws));
      this.provisioned.set(ws, p);
    }
    return p;
  }

  async indexFact(fact: Fact): Promise<void> {
    const { facts } = await this.sessions(fact.bankId);
    const metadata: Record<string, string> = {
      refId: fact.id,
      kind: "fact",
      validFrom: fact.validity.validFrom.toISOString(),
      retracted: String(fact.transaction.retractedAt !== undefined),
    };
    if (fact.validity.validTo) metadata.validTo = fact.validity.validTo.toISOString();
    await this.upsert(facts, fact.id, fact.statement, fact.validity.validFrom, metadata);
  }

  async indexEpisode(episode: Episode): Promise<void> {
    const { episodes } = await this.sessions(episode.bankId);
    const metadata: Record<string, string> = { refId: episode.id, kind: "episode", validFrom: episode.occurredAt.toISOString(), retracted: "false" };
    if (episode.role) metadata.role = episode.role;
    await this.upsert(episodes, episode.id, episode.text, episode.occurredAt, metadata);
  }

  /**
   * Statements are immutable in our domain (supersession makes a new Fact), so a re-index only has new
   * metadata. A session handle this process cached can be stale after another process purged the
   * workspace (admin erase-bank / reindex): a 404 or 409 drops the cached provisioning and retries once.
   */
  private async upsert(session: Session, refId: string, content: string, createdAt: Date, metadata: Record<string, string>, retry = true): Promise<void> {
    try {
      await this.write(session, refId, content, createdAt, metadata);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (!retry || (status !== 404 && status !== 409)) throw e;
      this.provisioned.delete(session.workspaceId);
      const fresh = await this.sessions(session.workspaceId.slice(this.prefix.length) as BankId);
      await this.upsert(session.id === FACTS ? fresh.facts : fresh.episodes, refId, content, createdAt, metadata, false);
    }
  }

  private async write(session: Session, refId: string, content: string, createdAt: Date, metadata: Record<string, string>): Promise<void> {
    const existing = await this.findByRef(session, refId);
    if (existing) {
      await session.updateMessage(existing, metadata);
      return;
    }
    await session.addMessages({ peerId: PEER, content, metadata, createdAt: createdAt.toISOString() });
    // Honcho embeds a new message in a background task ("searchable within seconds"). Search fuses a
    // keyword arm with the vector arm and exposes no embedding status, so this probe only proves the
    // row is visible to search, not that its vector exists; it is the closest the API allows.
    const deadline = Date.now() + this.searchableTimeoutMs;
    for (;;) {
      const found = await session.search(content, { filters: { metadata: { refId } }, limit: 1 });
      if (found.length > 0) return;
      if (Date.now() > deadline) {
        console.warn(`honcho: message ${refId} in ${session.workspaceId}/${session.id} not searchable after ${this.searchableTimeoutMs} ms; continuing`);
        return;
      }
      await sleep(250);
    }
  }

  private async findByRef(session: Session, refId: string): Promise<Message | undefined> {
    const page = await session.messages({ filters: { metadata: { refId } }, size: 1 });
    return page.items[0];
  }

  async retractFact(bankId: BankId, factId: FactId): Promise<void> {
    const ws = this.workspace(bankId);
    // Only a workspace that exists and already has a facts session (read over HTTP; `session()` would get-or-create one).
    if (!(await this.workspaceExists(ws)) || !(await this.sessionIds(ws)).includes(FACTS)) return;
    const facts = await this.clientFor(ws).session(FACTS);
    const existing = await this.findByRef(facts, factId);
    if (existing) await facts.updateMessage(existing, { ...existing.metadata, retracted: "true" });
  }

  async recall(scope: Scope, query: string, options: RecallOptions): Promise<readonly RankedHit[]> {
    const ws = this.workspace(scope.bankId);
    if (!(await this.workspaceExists(ws))) return [];
    const honcho = this.clientFor(ws);
    const kinds = new Set(options.includeEpisodes ? ["fact", "episode"] : ["fact"]);
    // What Honcho's filter grammar can take: retraction flag, validFrom (= created_at) and, for a facts-only
    // recall, the facts session, so episodes cannot crowd facts out of the over-fetch; validTo stays here.
    const filters = {
      metadata: { retracted: "false" },
      ...(options.includeEpisodes ? {} : { session_id: FACTS }),
      ...(options.asOf ? { created_at: { lte: options.asOf.toISOString() } } : {}),
    };
    const messages = await honcho.search(query, { filters, limit: Math.min(SEARCH_MAX, Math.max(options.limit * 5, 20)) });
    const asOf = (options.asOf ?? new Date()).getTime();
    const hits: RankedHit[] = [];
    const seen = new Set<string>();
    messages.forEach((m, i) => {
      if (hits.length >= options.limit) return;
      const md = m.metadata as Record<string, unknown>;
      const refId = typeof md.refId === "string" ? md.refId : undefined;
      const kind = typeof md.kind === "string" ? md.kind : undefined;
      if (!refId || !kind || !kinds.has(kind) || md.retracted === "true" || seen.has(`${kind}:${refId}`)) return;
      const from = typeof md.validFrom === "string" ? Date.parse(md.validFrom) : Number.NEGATIVE_INFINITY;
      const to = typeof md.validTo === "string" ? Date.parse(md.validTo) : Number.POSITIVE_INFINITY;
      if (!(from <= asOf && asOf < to)) return;
      seen.add(`${kind}:${refId}`);
      const score = 1 / (i + 1);
      hits.push(kind === "fact" ? { factId: refId as FactId, score } : { episodeId: refId as EpisodeId, score });
    });
    return hits;
  }

  private async workspaceExists(ws: string): Promise<boolean> {
    const p = await this.clientFor(ws).workspaces({ filters: { id: ws }, size: 1 });
    return p.items.includes(ws);
  }

  /** Messages in the bank's sessions as Honcho reports them, read without get-or-create; a missing workspace or session is zero. */
  async countBank(bankId: BankId): Promise<number> {
    const ws = this.workspace(bankId);
    let n = 0;
    for (const id of await this.sessionIds(ws)) n += await this.messageCount(ws, id);
    return n;
  }

  async purgeBank(bankId: BankId): Promise<{ readonly deleted: number; readonly remaining: number }> {
    const ws = this.workspace(bankId);
    this.provisioned.delete(ws);
    const before = await this.countBank(bankId);
    if (await this.workspaceExists(ws)) {
      const honcho = this.clientFor(ws);
      for (const id of await this.sessionIds(ws)) await (await honcho.session(id)).delete();
      await honcho.deleteWorkspace(ws);
    }
    // Deletion is a background job in Honcho; wait for its API to stop reporting the data, and
    // require two consecutive empty readings so the caller never lands in the deletion window.
    const deadline = Date.now() + this.purgeTimeoutMs;
    let remaining = await this.countBank(bankId);
    let clean = 0;
    while (clean < 2 && Date.now() < deadline) {
      if (remaining === 0 && !(await this.workspaceExists(ws))) clean++;
      else clean = 0;
      if (clean < 2) await sleep(500);
      remaining = await this.countBank(bankId);
    }
    if (clean < 2) console.warn(`honcho: ${ws} still reported after ${this.purgeTimeoutMs} ms (${remaining} message(s)); deletion is a deriver job, check that the deriver is running`);
    return { deleted: before, remaining };
  }

  async rebuild(bankId: BankId, facts: AsyncIterable<Fact>, episodes: AsyncIterable<Episode>): Promise<void> {
    const purged = await this.purgeBank(bankId);
    if (purged.remaining > 0) throw new Error(`honcho: ${purged.remaining} message(s) remain in ${this.workspace(bankId)} after purge; refusing to rebuild on top`);
    for await (const f of facts) await this.indexFact(f);
    for await (const e of episodes) await this.indexEpisode(e);
  }
}
