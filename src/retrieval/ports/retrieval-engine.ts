import type { BankId, EpisodeId, FactId, Scope } from "../../shared-kernel/index.js";
import type { Episode, Fact } from "../../memory/index.js";

/**
 * RetrievalEngine: the port every engine adapter implements (pgvector, Hindsight, Honcho).
 * Engines hold DERIVED state only. They must be rebuildable from Facts and Episodes, and
 * they must be able to purge a Bank (one Subject's store) completely and prove it (used by Erasure).
 *
 * Hits carry OUR ids. The engine's own text is never surfaced to callers.
 */

export interface RankedHit {
  readonly factId?: FactId;
  readonly episodeId?: EpisodeId;
  readonly score: number;
}

export interface RecallOptions {
  readonly limit: number;
  /** Point-in-time recall: only facts valid at this instant. Default: now. */
  readonly asOf?: Date;
  readonly includeEpisodes?: boolean;
}

export interface RetrievalEngine {
  readonly name: string; // "pgvector" | "hindsight" | "honcho"
  indexFact(fact: Fact): Promise<void>;
  indexEpisode(episode: Episode): Promise<void>;
  /** Called on supersession/invalidation so the engine stops surfacing retracted facts as current. */
  retractFact(factId: FactId): Promise<void>;
  recall(scope: Scope, query: string, options: RecallOptions): Promise<readonly RankedHit[]>;
  /** Erasure inventory and verification: how many rows (facts and episodes) the engine holds for the bank. */
  countBank(bankId: BankId): Promise<number>;
  /** Erasure: remove everything the engine holds for the bank, then re-count; `remaining` must be 0. */
  purgeBank(bankId: BankId): Promise<{ readonly deleted: number; readonly remaining: number }>;
  /** Drop derived state for a bank so it can be replayed from the system of record. */
  rebuild(bankId: BankId, facts: AsyncIterable<Fact>, episodes: AsyncIterable<Episode>): Promise<void>;
}
