import type { BankId, DomainEvent, EpisodeId, FactId, Scope } from "../../shared-kernel/index.js";
import type { Bank } from "../domain/bank.js";
import type { Episode } from "../domain/episode.js";
import type { Fact } from "../domain/fact.js";

/**
 * Ports the Memory application layer needs. Implemented in infrastructure (Postgres)
 * and in test doubles (in-memory). Every read takes a Scope so the adapter can apply
 * row-level filtering as a second line of defence behind Governance policy.
 */

export interface BankRepository {
  get(bankId: BankId): Promise<Bank | undefined>;
  save(bank: Bank): Promise<void>;
}

export interface EpisodeRepository {
  /** Append only. Must reject a second write with the same id or externalRef (idempotency). */
  append(episode: Episode): Promise<void>;
  get(scope: Scope, id: EpisodeId): Promise<Episode | undefined>;
  listByBank(scope: Scope, opts?: { readonly after?: Date; readonly limit?: number }): Promise<readonly Episode[]>;
}

export interface FactRepository {
  insert(fact: Fact): Promise<void>;
  /** Replace by id; used for supersession/invalidation/confirmation state changes. */
  update(fact: Fact): Promise<void>;
  get(scope: Scope, id: FactId): Promise<Fact | undefined>;
  getMany(scope: Scope, ids: readonly FactId[]): Promise<readonly Fact[]>;
  listCurrent(scope: Scope, at?: Date): Promise<readonly Fact[]>;
}

/** Transactional outbox: events are written in the same transaction as the state change. */
export interface Outbox {
  publish(events: readonly DomainEvent[]): Promise<void>;
}

/** Unit of work: groups repository writes and outbox publish into one transaction. */
export interface UnitOfWork {
  run<T>(work: (tx: { banks: BankRepository; episodes: EpisodeRepository; facts: FactRepository; outbox: Outbox }) => Promise<T>): Promise<T>;
}
