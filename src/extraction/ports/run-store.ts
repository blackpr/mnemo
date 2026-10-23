import type { BankId, EpisodeId, ModelRef, TenantId } from "../../shared-kernel/index.js";
import type { ExtractionUsage } from "./extractor.js";

/**
 * Extraction work queue, idempotency record and cost ledger, one row per episode.
 *
 *   pending --claim--> running --complete--> done
 *                        |--fail(retryable)--> failed (next_attempt_at) --claim--> running
 *                        |--fail(fatal)-----> dead
 *   skipped: never to be extracted (bank has no extractor, episode not Subject-authored, ...)
 *
 * The outbox consumer only enqueues (fast, inside the relay's transaction); a separate worker
 * claims and processes rows on its own schedule, so a slow or hung model call never blocks
 * indexing. A running claim older than `staleAfterMs` is considered abandoned and may be retaken.
 */
export type RunStatus = "pending" | "running" | "done" | "failed" | "dead" | "skipped";

export interface ClaimedRun {
  readonly episodeId: EpisodeId;
  readonly bankId: BankId;
  readonly tenantId: TenantId;
  readonly attempts: number; // including this one
  /** Claim token: complete/fail only apply while this claim is still the current one. */
  readonly claimedAt: Date;
}

export interface ExtractionRunOutcome {
  readonly usage: ExtractionUsage;
  readonly candidates: number;
  readonly asserted: number;
  readonly superseded: number;
  readonly invalidated: number;
  readonly historical: number;
  readonly rejected: number;
}

export interface ExtractionRunStore {
  /** Idempotent: a row that already exists (any status) is left untouched. */
  enqueue(episodeId: EpisodeId, bankId: BankId, tenantId: TenantId, now: Date): Promise<void>;
  /** Claims the oldest due row, if any. Safe to call from several workers concurrently. */
  claimNext(now: Date, opts: { readonly staleAfterMs: number; readonly maxAttempts: number }): Promise<ClaimedRun | undefined>;
  /** No-op if the claim was superseded by a stale retake (returns false). */
  complete(claim: ClaimedRun, extractor: ModelRef, outcome: ExtractionRunOutcome, now: Date): Promise<boolean>;
  /** `retryAt` undefined means fatal: the row becomes dead and is never retried automatically. No-op if the claim was superseded. */
  fail(claim: ClaimedRun, error: string, now: Date, retryAt: Date | undefined, usage?: ExtractionUsage): Promise<boolean>;
  skip(claim: ClaimedRun, reason: string, now: Date): Promise<void>;
  /** Marks running rows whose claim went stale after the attempt limit as dead (a crashing worker never reaches fail()). */
  sweepStale(now: Date, opts: { readonly staleAfterMs: number; readonly maxAttempts: number }): Promise<number>;
  /** Operator action: put failed and dead rows back to pending. Returns the count. */
  requeueFailed(): Promise<number>;
  counts(): Promise<Readonly<Record<RunStatus, number>>>;
  /** Erasure: rows (any status) for the bank, and their removal. The ledger holds token counts and errors, never episode text, but it is per Subject. */
  countByBank(bankId: BankId): Promise<number>;
  purgeBank(bankId: BankId): Promise<number>;
}
