import type { BankId, ModelRef, SubjectId, TenantId } from "../../shared-kernel/index.js";

export type BankStatus = "active" | "frozen" | "erasing" | "erased";

/**
 * Bank: the isolated memory store for one Subject within one Tenant.
 * Small aggregate: identity, status, and the policies that govern writes into it.
 * Invariant 5: a Fact belongs to exactly one Bank, forever.
 */
export interface Bank {
  readonly id: BankId;
  readonly tenantId: TenantId;
  readonly subjectId: SubjectId;
  readonly status: BankStatus;
  readonly policy: BankPolicy;
  readonly createdAt: Date;
}

export interface BankPolicy {
  /** Which extractor to run on new Episodes. undefined = no extraction (pgvector-only arm). */
  readonly extractor?: ModelRef;
  /** Near-duplicate threshold for the write policy, 0..1 cosine similarity. */
  readonly dedupeThreshold: number;
  /** Minimum faithfulness score required to store a machine-written fact. */
  readonly minFaithfulness: number;
  /** Decay is off by default; only Erasure removes data (ARCHITECTURE.md section 7). */
  readonly decayEnabled: false;
}

export const defaultBankPolicy: BankPolicy = Object.freeze({
  dedupeThreshold: 0.92,
  minFaithfulness: 0.6,
  decayEnabled: false,
});

export function createBank(
  id: BankId,
  tenantId: TenantId,
  subjectId: SubjectId,
  createdAt: Date,
  policy: Partial<Omit<BankPolicy, "decayEnabled">> = {},
): Bank {
  return Object.freeze({
    id,
    tenantId,
    subjectId,
    status: "active" as const,
    policy: { ...defaultBankPolicy, ...policy, decayEnabled: false as const },
    createdAt,
  });
}

export const canAcceptWrites = (bank: Bank): boolean => bank.status === "active";

/**
 * Erasure (Governance drives it; Memory owns the Bank's status). `erasing` refuses writes for
 * the duration of the workflow; `erased` is the tombstone that keeps the id from ever being
 * reused. An erased bank may be erased again: the pass re-proves zero rows and issues a fresh receipt.
 * A `frozen` bank goes through the same states; the freeze is not restored afterwards (it is erased).
 */
export function beginErasure(bank: Bank): Bank {
  return Object.freeze({ ...bank, status: "erasing" as const });
}

export function markErased(bank: Bank): Bank {
  return Object.freeze({ ...bank, status: "erased" as const });
}
