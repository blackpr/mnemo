import type { BankId, PrincipalId, Result, SubjectId, TenantId } from "../../shared-kernel/index.js";
import { err, ok } from "../../shared-kernel/index.js";
import { canonicalJson, type Hasher } from "./audit-log.js";

/**
 * ErasureRequest: compliance deletion as a state machine that fails closed.
 *
 *   requested -> inventoried -> deleted -> verified -> receipted
 *
 * Every store that holds Subject data (facts, episodes, embeddings, engine stores, caches)
 * is listed at inventory time; deletion and verification are recorded per store; the receipt
 * is only issued when every store reports zero hits on re-query. "Deleted" is not the same
 * as "provably deleted" (ARCHITECTURE.md 2.2). Any step may move the request to `failed`;
 * the deletions recorded until then stay on the request so a retry knows what already went.
 */

export type ErasureState = "requested" | "inventoried" | "deleted" | "verified" | "receipted" | "failed";

export interface StoreInventory {
  readonly store: string; // "memory.facts" | "memory.episodes" | "retrieval.pgvector" | "engine.hindsight" | ...
  readonly countBefore: number;
}

export interface StoreDeletion {
  readonly store: string;
  readonly deleted: number;
  readonly deletedAt: Date;
  /** Ids the purge named (e.g. the principals whose keys were revoked); never names or secrets. Covered by the receipt digest. */
  readonly evidence?: Readonly<Record<string, readonly string[]>>;
}

export interface StoreVerification {
  readonly store: string;
  readonly hitsAfter: number;
  readonly checkedAt: Date;
}

export interface ErasureReceipt {
  readonly requestId: string;
  readonly tenantId: TenantId;
  readonly bankId: BankId;
  readonly subjectId: SubjectId;
  /** What was deleted per store, and the zero-hit re-count per store. */
  readonly deletions: readonly StoreDeletion[];
  readonly stores: readonly StoreVerification[];
  readonly issuedAt: Date;
  /** Hash over every field above; chained into the audit log as `erasure.receipt_issued`. */
  readonly digest: string;
}

export interface ErasureRequest {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly bankId: BankId;
  readonly subjectId: SubjectId;
  readonly requestedBy: PrincipalId;
  readonly requestedAt: Date;
  readonly state: ErasureState;
  readonly inventory: readonly StoreInventory[];
  readonly deletions: readonly StoreDeletion[];
  readonly verifications: readonly StoreVerification[];
  readonly receipt?: ErasureReceipt;
  /** Operator-readable, bounded, never a store's raw error text (that goes to the process log). */
  readonly failure?: string;
  /** Set by the repository on read: when the row last changed. Used to tell a stuck request from a slow one. */
  readonly updatedAt?: Date;
}

export type ErasureError = { readonly kind: "InvalidTransition"; readonly from: ErasureState; readonly to: ErasureState } | { readonly kind: "VerificationFailed"; readonly stores: readonly string[] };

export function requestErasure(input: Omit<ErasureRequest, "state" | "inventory" | "deletions" | "verifications">): ErasureRequest {
  return Object.freeze({ ...input, state: "requested", inventory: [], deletions: [], verifications: [] });
}

const transition = (r: ErasureRequest, from: ErasureState, to: ErasureState): Result<true, ErasureError> =>
  r.state === from ? ok(true) : err({ kind: "InvalidTransition", from: r.state, to });

export function recordInventory(r: ErasureRequest, inventory: readonly StoreInventory[]): Result<ErasureRequest, ErasureError> {
  const t = transition(r, "requested", "inventoried");
  if (!t.ok) return t;
  return ok(Object.freeze({ ...r, state: "inventoried", inventory }));
}

/** One store purged. Recorded while still `inventoried`, so a failure in the next store leaves this one's count on the request. */
export function recordDeletion(r: ErasureRequest, deletion: StoreDeletion): Result<ErasureRequest, ErasureError> {
  const t = transition(r, "inventoried", "inventoried");
  if (!t.ok) return t;
  return ok(Object.freeze({ ...r, deletions: [...r.deletions, deletion] }));
}

export function markDeleted(r: ErasureRequest): Result<ErasureRequest, ErasureError> {
  const t = transition(r, "inventoried", "deleted");
  if (!t.ok) return t;
  return ok(Object.freeze({ ...r, state: "deleted" }));
}

/** Verification passes only if every inventoried store reports zero hits. Otherwise the request fails closed. */
export function recordVerification(r: ErasureRequest, verifications: readonly StoreVerification[]): Result<ErasureRequest, ErasureError> {
  const t = transition(r, "deleted", "verified");
  if (!t.ok) return t;
  const inventoried = new Set(r.inventory.map((i) => i.store));
  const verifiedStores = new Set(verifications.map((v) => v.store));
  const missing = [...inventoried].filter((s) => !verifiedStores.has(s));
  const nonZero = verifications.filter((v) => v.hitsAfter > 0).map((v) => v.store);
  const failing = [...missing, ...nonZero];
  if (failing.length > 0) {
    return err({ kind: "VerificationFailed", stores: failing });
  }
  return ok(Object.freeze({ ...r, state: "verified", verifications }));
}

/**
 * The exact bytes a receipt's digest covers. Canonical JSON (sorted keys), so a receipt read
 * back from jsonb, which does not keep key order, still verifies.
 */
export function receiptPayload(receipt: Omit<ErasureReceipt, "digest">): string {
  return canonicalJson({
    requestId: receipt.requestId,
    tenantId: receipt.tenantId,
    bankId: receipt.bankId,
    subjectId: receipt.subjectId,
    deletions: receipt.deletions.map((d) => ({ store: d.store, deleted: d.deleted, deletedAt: d.deletedAt.toISOString(), ...(d.evidence ? { evidence: d.evidence } : {}) })),
    stores: receipt.stores.map((s) => ({ store: s.store, hitsAfter: s.hitsAfter, checkedAt: s.checkedAt.toISOString() })),
    issuedAt: receipt.issuedAt.toISOString(),
  });
}

export function verifyReceipt(receipt: ErasureReceipt, hash: Hasher): boolean {
  return hash(receiptPayload(receipt)) === receipt.digest;
}

export function issueReceipt(r: ErasureRequest, issuedAt: Date, digest: Hasher): Result<ErasureRequest, ErasureError> {
  const t = transition(r, "verified", "receipted");
  if (!t.ok) return t;
  const unsigned = { requestId: r.id, tenantId: r.tenantId, bankId: r.bankId, subjectId: r.subjectId, deletions: r.deletions, stores: r.verifications, issuedAt };
  const receipt: ErasureReceipt = Object.freeze({ ...unsigned, digest: digest(receiptPayload(unsigned)) });
  return ok(Object.freeze({ ...r, state: "receipted", receipt }));
}

/** Terminal. Keeps inventory and deletions; `verifications` lets a failed verification show which stores still had hits. */
export function fail(r: ErasureRequest, reason: string, verifications: readonly StoreVerification[] = r.verifications): ErasureRequest {
  return Object.freeze({ ...r, state: "failed", failure: reason, verifications });
}
