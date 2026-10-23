import type { BankId, Clock, EpisodeId, FactId, Result, Scope } from "../../shared-kernel/index.js";
import { ok } from "../../shared-kernel/index.js";
import type { AccessDenied, AccessPolicy, AuditLogStore } from "../../governance/index.js";
import type { Episode } from "../domain/episode.js";
import { isCurrent, type Fact } from "../domain/fact.js";
import type { EpisodeRepository, FactRepository } from "../ports/repositories.js";

/**
 * Port owned by Memory for what it needs from Retrieval: ranked ids for a query.
 * The engine's own text is never returned to callers; facts and episodes are re-read through
 * the repositories under the caller's Scope so Governance applies on every path, and facts are
 * re-checked against the system of record's validity (the index may lag).
 */
export interface MemoryHit {
  readonly factId?: FactId;
  readonly episodeId?: EpisodeId;
  readonly score: number;
}

export interface MemoryFinderOptions {
  readonly limit: number;
  readonly asOf?: Date;
  readonly includeEpisodes?: boolean;
}

export interface MemoryFinder {
  find(scope: Scope, query: string, options: MemoryFinderOptions): Promise<readonly MemoryHit[]>;
}

export interface RecallQuery {
  readonly bankId: BankId;
  readonly query: string;
  readonly limit?: number;
  readonly asOf?: Date;
  readonly includeEpisodes?: boolean;
}

export interface RecallResult {
  readonly facts: readonly (Fact & { readonly score: number })[];
  readonly episodes: readonly (Episode & { readonly score: number })[];
}

export class RecallHandler {
  constructor(
    private readonly finder: MemoryFinder,
    private readonly facts: FactRepository,
    private readonly episodes: EpisodeRepository,
    private readonly access: AccessPolicy,
    private readonly audit: AuditLogStore,
    private readonly clock: Clock,
  ) {}

  async handle(scope: Scope, q: RecallQuery): Promise<Result<RecallResult, AccessDenied>> {
    const allowed = this.access.canRead(scope, q.bankId);
    if (!allowed.ok) return allowed;

    const limit = q.limit ?? 10;
    const hits = await this.finder.find(scope, q.query, {
      limit,
      ...(q.asOf !== undefined ? { asOf: q.asOf } : {}),
      ...(q.includeEpisodes !== undefined ? { includeEpisodes: q.includeEpisodes } : {}),
    });

    const factScores = new Map<FactId, number>();
    const episodeScores = new Map<EpisodeId, number>();
    for (const h of hits) {
      if (h.factId !== undefined) factScores.set(h.factId, h.score);
      else if (h.episodeId !== undefined) episodeScores.set(h.episodeId, h.score);
    }

    const at = q.asOf ?? this.clock.now();
    const facts = (await this.facts.getMany(scope, [...factScores.keys()]))
      .filter((f) => isCurrent(f, at))
      .map((f) => ({ ...f, score: factScores.get(f.id) ?? 0 }))
      .sort((a, b) => b.score - a.score);

    const episodes = (await this.episodes.getMany(scope, [...episodeScores.keys()]))
      .map((e) => ({ ...e, score: episodeScores.get(e.id) ?? 0 }))
      .sort((a, b) => b.score - a.score);

    await this.audit.append({
      tenantId: scope.tenantId,
      bankId: q.bankId,
      principalId: scope.principalId,
      action: "recall.served",
      details: { factIds: facts.map((f) => f.id), episodeIds: episodes.map((e) => e.id) },
      at: this.clock.now(),
    });
    return ok({ facts, episodes });
  }
}
