import type { BankId, DomainEvent, EpisodeId, FactId, PrincipalId, Scope } from "../../shared-kernel/index.js";
import type { AuditLogStore } from "../../governance/index.js";
import type { Bank } from "../domain/bank.js";
import type { Episode } from "../domain/episode.js";
import type { Fact } from "../domain/fact.js";

/**
 * Ports the Memory application layer needs. Implemented in infrastructure (Postgres)
 * and in test doubles (in-memory). Every read takes a Scope so the adapter can apply
 * row-level filtering as a second line of defence behind Governance policy.
 */

/** Thrown by EpisodeRepository.append when the id or (bank, externalRef) already exists. Part of the port contract. */
export class DuplicateEpisodeError extends Error {
  constructor(readonly episodeId: EpisodeId) {
    super(`Episode ${episodeId} (or its externalRef) already exists`);
    this.name = "DuplicateEpisodeError";
  }
}

/** Thrown by FactRepository.insert when the id already exists. Part of the port contract. */
export class DuplicateFactError extends Error {
  constructor(readonly factId: FactId) {
    super(`Fact ${factId} already exists`);
    this.name = "DuplicateFactError";
  }
}

export interface BankRepository {
  /**
   * `lock: "share"` (writers, inside their transaction) and `lock: "update"` (the erasure freeze) make the
   * bank status check and the write it guards one atomic unit: a writer that read `active` holds the row
   * until it commits, and the freeze waits for it, so nothing can be written after verification.
   */
  get(bankId: BankId, opts?: { readonly lock?: "share" | "update" }): Promise<Bank | undefined>;
  /** Insert only; a Bank's identity never changes hands. Throws if the id exists. */
  create(bank: Bank): Promise<void>;
  /** Update status, policy and engine of an existing bank. */
  update(bank: Bank): Promise<void>;
}

export interface EpisodeRepository {
  /** Append only. Throws DuplicateEpisodeError on a second write with the same id or externalRef. */
  append(episode: Episode): Promise<void>;
  get(scope: Scope, id: EpisodeId): Promise<Episode | undefined>;
  getMany(scope: Scope, ids: readonly EpisodeId[]): Promise<readonly Episode[]>;
  listByBank(scope: Scope, opts?: { readonly after?: Date; readonly limit?: number }): Promise<readonly Episode[]>;
  /** The `limit` most recent episodes at or before `before` (default now), returned oldest first. */
  listRecent(scope: Scope, limit: number, before?: Date): Promise<readonly Episode[]>;
}

export interface FactRepository {
  /** Throws DuplicateFactError if the id exists. */
  insert(fact: Fact): Promise<void>;
  /** Replace by id; used for supersession/invalidation/confirmation state changes. */
  update(fact: Fact): Promise<void>;
  /** `forUpdate` locks the row for the rest of the transaction; use before read-modify-write. */
  get(scope: Scope, id: FactId, opts?: { readonly forUpdate?: boolean }): Promise<Fact | undefined>;
  getMany(scope: Scope, ids: readonly FactId[]): Promise<readonly Fact[]>;
  listCurrent(scope: Scope, at?: Date): Promise<readonly Fact[]>;
  /** Every fact in the bank, including closed and retracted ones (for index rebuilds and exports). */
  listAll(scope: Scope): Promise<readonly Fact[]>;
  /** True if `writer` already produced facts while processing `triggerEpisodeId`. Extraction idempotency check. */
  existsForTrigger(scope: Scope, triggerEpisodeId: EpisodeId, writer: PrincipalId): Promise<boolean>;
}

/** Transactional outbox: events are written in the same transaction as the state change. */
export interface Outbox {
  publish(events: readonly DomainEvent[]): Promise<void>;
}

export interface TransactionalRepositories {
  readonly banks: BankRepository;
  readonly episodes: EpisodeRepository;
  readonly facts: FactRepository;
  readonly outbox: Outbox;
  /** Audit entries written here commit or roll back together with the state change. */
  readonly audit: AuditLogStore;
}

/** Unit of work: groups repository writes, outbox publish and audit append into one transaction. */
export interface UnitOfWork {
  run<T>(work: (tx: TransactionalRepositories) => Promise<T>): Promise<T>;
}
