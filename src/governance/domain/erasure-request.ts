import type { BankId, PrincipalId, Result, SubjectId, TenantId } from "../../shared-kernel/index.js";
import { err, ok } from "../../shared-kernel/index.js";

/**
 * ErasureRequest: compliance deletion as a state machine that fails closed.
 *
 *   requested -> inventoried -> deleted -> verified -> receipted
 *
 * Every store that holds Subject data (facts, episodes, embeddings, engine stores, caches)
 * is listed at inventory time; deletion and verification are recorded per store; the receipt
 * is only issued when every store reports zero hits on re-query. "Deleted" is not the same
 * as "provably deleted" (ARCHITECTURE.md 2.2).
 */

export type ErasureState = "requested" | "inventoried" | "deleted" | "verified" | "receipted" | "failed";

export interface StoreInventory {
  readonly store: string; // "memory.facts" | "memory.episodes" | "retrieval.pgvector" | "engine.hindsight" | ...
  readonly countBefore: number;
}

export interface StoreVerification {
  readonly store: string;
  readonly hitsAfter: number;
  readonly checkedAt: Date;
}

export interface ErasureReceipt {
  readonly requestId: string;
  readonly subjectId: SubjectId;
  readonly stores: readonly StoreVerification[];
  readonly issuedAt: Date;
  /** Hash over (requestId, subjectId, stores, issuedAt); chained into the audit log. */
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
  readonly verifications: readonly StoreVerification[];
  readonly receipt?: ErasureReceipt;
  readonly failure?: string;
}

export type ErasureError = { readonly kind: "InvalidTransition"; readonly from: ErasureState; readonly to: ErasureState } | { readonly kind: "VerificationFailed"; readonly stores: readonly string[] };

export function requestErasure(input: Omit<ErasureRequest, "state" | "inventory" | "verifications">): ErasureRequest {
  return Object.freeze({ ...input, state: "requested", inventory: [], verifications: [] });
}

const transition = (r: ErasureRequest, from: ErasureState, to: ErasureState): Result<true, ErasureError> =>
  r.state === from ? ok(true) : err({ kind: "InvalidTransition", from: r.state, to });

export function recordInventory(r: ErasureRequest, inventory: readonly StoreInventory[]): Result<ErasureRequest, ErasureError> {
  const t = transition(r, "requested", "inventoried");
  if (!t.ok) return t;
  return ok(Object.freeze({ ...r, state: "inventoried", inventory }));
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

export function issueReceipt(r: ErasureRequest, issuedAt: Date, digest: (payload: string) => string): Result<ErasureRequest, ErasureError> {
  const t = transition(r, "verified", "receipted");
  if (!t.ok) return t;
  const payload = JSON.stringify({ id: r.id, subjectId: r.subjectId, stores: r.verifications, issuedAt });
  const receipt: ErasureReceipt = {
    requestId: r.id,
    subjectId: r.subjectId,
    stores: r.verifications,
    issuedAt,
    digest: digest(payload),
  };
  return ok(Object.freeze({ ...r, state: "receipted", receipt }));
}

export function fail(r: ErasureRequest, reason: string): ErasureRequest {
  return Object.freeze({ ...r, state: "failed", failure: reason });
}
