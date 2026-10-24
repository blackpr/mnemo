import type { BankId, PrincipalId, SubjectId, TenantId } from "../../shared-kernel/index.js";
import type { AuditAction, AuditEntry } from "../domain/audit-log.js";
import type { ErasureRequest } from "../domain/erasure-request.js";
import type { Principal } from "../domain/principal.js";

export interface PrincipalRepository {
  get(id: PrincipalId): Promise<Principal | undefined>;
  /** Upsert the principal and replace its grants. */
  save(principal: Principal): Promise<void>;
  findByApiKeyHash(hash: string): Promise<Principal | undefined>;
}

export interface ApiKeyStore {
  issue(principalId: PrincipalId, hash: string, label: string): Promise<void>;
  /** Returns false if the key was unknown or already revoked. */
  revoke(hash: string): Promise<boolean>;
}

export type NewAuditEntry = Omit<AuditEntry, "seq" | "prevHash" | "hash">;

export interface AuditLogStore {
  /** Append one hash-chained entry for the tenant. Serialized per tenant by the adapter. */
  append(entry: NewAuditEntry): Promise<AuditEntry>;
  list(tenantId: TenantId, opts?: { readonly limit?: number }): Promise<readonly AuditEntry[]>;
}

/** The one thing Governance needs to know about a Bank: which tenant owns it. Implemented by Memory's bank repository. */
export interface BankTenantLookup {
  tenantOf(bankId: BankId): Promise<TenantId | undefined>;
}

// ---------- Erasure ----------

/** Thrown by ErasureRequestRepository.create when another request for the bank is still in flight (not receipted or failed). */
export class ErasureInFlightError extends Error {
  constructor(readonly bankId: BankId) {
    super(`An erasure for bank ${bankId} is already in flight`);
    this.name = "ErasureInFlightError";
  }
}

/** Thrown by ErasureRequestRepository.save when the stored row is already receipted or failed: a terminal state is never overwritten. */
export class ErasureNotInFlightError extends Error {
  constructor(readonly requestId: string) {
    super(`Erasure request ${requestId} is no longer in flight`);
    this.name = "ErasureNotInFlightError";
  }
}

export interface ErasureRequestRepository {
  /** Insert a new request in state `requested`. Throws ErasureInFlightError if the bank already has one in flight. */
  create(request: ErasureRequest): Promise<void>;
  /** Persist a transition produced by the domain functions (never a raw status update). Throws ErasureNotInFlightError if the row is terminal. */
  save(request: ErasureRequest): Promise<void>;
  /** `within` narrows to a bank and tenant in SQL (second line of defence behind the handler's check); omitted only by operator tooling. */
  get(id: string, within?: { readonly bankId: BankId; readonly tenantId: TenantId }): Promise<ErasureRequest | undefined>;
}

/** Request writes and their audit entries commit or roll back together (a request is never recorded without its audit trail, nor the reverse). */
export interface ErasureTransaction {
  readonly requests: ErasureRequestRepository;
  readonly audit: AuditLogStore;
}

export interface ErasureUnitOfWork {
  run<T>(work: (tx: ErasureTransaction) => Promise<T>): Promise<T>;
}

/**
 * One adapter per context that holds Subject data, as the Erasure workflow sees it. `count`
 * and `purge` report per store name (e.g. "memory.facts"); the same names must come back from
 * both, because verification re-counts every inventoried store and fails closed on a missing
 * one. Implemented in Memory, Retrieval, Extraction, Portability and (for grants and keys) Governance; wired
 * by the composition root, Memory first and the access store last.
 */
export interface ErasableStore {
  /**
   * When set, the workflow appends an audit entry with this action right after the store's purge, carrying
   * the per-store deleted counts, in the same transaction as the request save. Only the access store's action
   * is allowed: the workflow's own entries (`requested`, `deleted`, `receipt_issued`, ...) cannot be forged this way.
   */
  readonly auditPurgeAs?: Extract<AuditAction, "erasure.access_revoked">;
  /** Store names must be stable and distinct per adapter. Memory must be listed first in the workflow: it removes the outbox events whose consumers (indexing, extraction) write into the stores purged after it. */
  count(bankId: BankId): Promise<Readonly<Record<string, number>>>;
  /** Delete everything the store holds for the bank; returns rows deleted per store name. */
  purge(bankId: BankId): Promise<Readonly<Record<string, number>>>;
}

/** What Governance needs from Memory about the Bank being erased. Implemented by Memory. */
export interface ErasureBankGateway {
  describe(bankId: BankId): Promise<{ readonly tenantId: TenantId; readonly subjectId: SubjectId } | undefined>;
  /** Freeze the bank for the duration of the workflow: no writes are accepted while an erasure is in flight. */
  beginErasure(bankId: BankId): Promise<void>;
  /** The bank row stays as a tombstone (status `erased`); the id is never reused. */
  completeErasure(bankId: BankId): Promise<void>;
}
