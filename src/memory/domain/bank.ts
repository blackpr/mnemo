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
  /**
   * The retrieval engine that holds this bank's derived index ("pgvector", "hindsight", "honcho"; Retrieval
   * owns the names, Memory only records the string). Set at creation to the server's engine, changed by
   * `admin reindex` when it moves the bank, so erasure can purge the engine that actually holds the bank.
   */
  readonly engine: string;
  readonly createdAt: Date;
}

/** Used by `createBank`'s default and the test fixtures; production callers pass the server's engine name explicitly. */
export const DEFAULT_ENGINE = "pgvector";
/** Lower-case identifier; Retrieval owns the actual names, Memory only refuses garbage that would make every erasure fail. */
const ENGINE_NAME = /^[a-z][a-z0-9_-]*$/;
function assertEngineName(engine: string): void {
  if (!ENGINE_NAME.test(engine)) throw new Error(`invalid retrieval engine name "${engine}"`);
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
  engine: string = DEFAULT_ENGINE,
): Bank {
  assertEngineName(engine);
  return Object.freeze({
    id,
    tenantId,
    subjectId,
    status: "active" as const,
    policy: { ...defaultBankPolicy, ...policy, decayEnabled: false as const },
    engine,
    createdAt,
  });
}

/** The bank's index now lives in another engine (`admin reindex` moved it). Only meaningful once the previous engine's copy is purged. */
export function switchEngine(bank: Bank, engine: string): Bank {
  assertEngineName(engine);
  return Object.freeze({ ...bank, engine });
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
