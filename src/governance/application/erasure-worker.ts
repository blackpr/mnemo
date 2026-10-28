import type { Clock, Result } from "../../shared-kernel/index.js";
import type { AuditEntry, Hasher } from "../domain/audit-log.js";
import {
  fail,
  issueReceipt,
  markDeleted,
  recordDeletion,
  recordInventory,
  recordVerification,
  type ErasureRequest,
  type StoreInventory,
  type StoreVerification,
} from "../domain/erasure-request.js";
import { ErasureClaimLostError, ErasureNotInFlightError, type ErasableStore, type ErasureBankGateway, type ErasureClaim, type ErasureRequestRepository, type ErasureUnitOfWork, type StorePurge } from "../ports/repositories.js";
import { wiredEngines } from "./erase-bank.js";

export interface ErasureWorkerOptions {
  /** A pass that has landed no step for this long is presumed dead (process gone, or hung) and is retaken by the next pass. Must exceed the slowest single store purge. */
  readonly staleAfterMs?: number;
  /** A request claimed more than this many times without reaching a terminal state is marked `failed` instead of being retaken again (default 3). */
  readonly maxAttempts?: number;
}

/** `lost`: the pass was retaken or the request abandoned while it ran; the stored row wins. `released`: the worker was asked to stop and handed the row back between steps. */
export type ErasureWorkOutcome = "idle" | "receipted" | "failed" | "lost" | "released";

/**
 * The erasure job runner: claims `requested` rows (and in-flight rows whose claim went stale) and runs the
 * workflow the way `EraseBankHandler` used to inside the HTTP request (ARCHITECTURE.md 2.2 and 6):
 *
 *   freeze -> inventory -> purge each store -> deleted -> verify -> tombstone -> receipt
 *
 * The claim is a short statement (`FOR UPDATE SKIP LOCKED`, a token and `claimed_at`); every store call runs
 * outside it, and every step lands through the request repository's compare-and-set `save`, with the claim
 * token, so a late save of a pass that was retaken (or of a request an operator abandoned) is refused and the
 * pass stops. The workflow resumes from the state the row is in, so a crash mid-purge is finished by the next
 * pass rather than needing `erasure-abandon` (which stays for operator use):
 *   - `requested`: the bank is frozen (`erasing`) under a row lock, so writers that already passed their
 *     status check finish first and later ones are refused; the recorded engine is re-checked under the lock.
 *     Then every store counts what it holds.
 *   - `inventoried`: every store purges, one at a time, each deletion saved before the next store starts (the
 *     access store, which declares `auditPurgeAs`, gets its `erasure.access_revoked` entry in that transaction;
 *     evidence a purge reports, such as the revoked principal ids, goes on the deletion and on that entry).
 *     On a resumed pass a store whose names are all already recorded is skipped, so a purge is never counted
 *     twice; a store purged by the dead pass but not yet saved is purged again, deletes nothing and records 0
 *     (its `countBefore` in the inventory still shows what it held). The freeze is re-asserted first (also when
 *     resuming at `deleted`): the bank must be `erasing` while stores are purged and re-counted whoever wrote the row.
 *   - `deleted`: every store counts again, given the recorded deletions so a store can re-count exactly what its purge
 *     named; any hit, or any inventoried store that did not report, fails closed.
 *   - `verified`: the bank becomes a tombstone (`erased`) and, in one transaction, the receipt is saved and its
 *     digest goes into the audit chain (`erasure.receipt_issued`).
 * Any failure leaves the request `failed` with the step and the error kind, whatever was deleted recorded per
 * store; the bank stays frozen so a new request can finish the job. Neither the audit log nor the request row
 * carries a store's raw error text (it may echo content or infrastructure details); that goes to the process log.
 * Audit entries name the principal that requested the erasure: the worker acts on its behalf.
 * Every save with the claim token is also the pass's heartbeat (`claimed_at` moves), so `staleAfterMs` bounds the time
 * between two steps, not a whole erasure. `stop()` makes the pass hand its row back at the next step boundary
 * (`release`), so a server restart does not leave a claim that nobody can take for `staleAfterMs`.
 */
export class ErasureWorker {
  private readonly staleAfterMs: number;
  private readonly maxAttempts: number;
  private stopping = false;
  /** The claim of the pass in progress, so a shutdown that runs out of time can hand it back mid-step (`releaseInFlight`). */
  private inFlight: ErasureClaim | undefined;

  constructor(
    private readonly requests: ErasureRequestRepository,
    private readonly bank: ErasureBankGateway,
    private readonly uow: ErasureUnitOfWork,
    private readonly stores: readonly ErasableStore[],
    private readonly clock: Clock,
    private readonly hash: Hasher,
    opts: ErasureWorkerOptions = {},
  ) {
    this.staleAfterMs = opts.staleAfterMs ?? 10 * 60_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  /** Process claimable requests until none is left, `max` is reached or `stop()` was called. Returns how many were processed (not idle). */
  async drain(max = 10): Promise<number> {
    let n = 0;
    while (n < max && !this.stopping) {
      const outcome = await this.processNext();
      if (outcome === "idle" || outcome === "released") break;
      n++;
    }
    return n;
  }

  /** Shutdown: finish the current step, hand the row back, claim nothing more. */
  stop(): void {
    this.stopping = true;
  }

  /**
   * Shutdown past its deadline: the pass is still inside a store call (a purge longer than the shutdown timeout), so it never
   * reaches the step boundary where `stop()` hands the row back. Release its claim now (token and `claimed_at` cleared) so the
   * next boot retakes the row at once instead of after `staleAfterMs`; the process is about to exit. The attempt is kept: a store
   * that hangs on every pass, restart after restart, still reaches `maxAttempts` and ends failed instead of blocking the queue.
   * The stuck call may still be running in this process (or its database statement on the server) when another instance retakes
   * the row; the two then purge the same store at once. The deletions are idempotent, but a transactional purge of the retaker
   * waits on the old statement's row locks, and two overlapping purge transactions can deadlock (40P01), which fails the request
   * (a new request finishes the job).
   * If the pass does get further, its next save carries a token the row no longer has and it stops as `lost`. The next pass
   * may purge the interrupted store again (purges are idempotent; a deletion the dead pass did not save is recorded as 0, its
   * `countBefore` in the inventory still says what the store held). A SIGKILL skips this and leaves the stale sweep to it.
   * Returns whether this pass's claim was handed back by this call; never throws (connections may already be going).
   */
  async releaseInFlight(): Promise<boolean> {
    const claim = this.inFlight;
    if (!claim) return false;
    this.stopping = true;
    try {
      return await this.requests.release(claim, { refund: false });
    } catch (e) {
      console.error(`erasure ${claim.request.id}: release at shutdown failed (${e instanceof Error ? e.name : typeof e}); the claim will go stale instead`);
      return false;
    }
  }

  async processNext(): Promise<ErasureWorkOutcome> {
    if (this.stopping) return "idle";
    const claim = await this.requests.claimNext({ staleAfterMs: this.staleAfterMs });
    if (!claim) return "idle";
    this.inFlight = claim;
    try {
      return await this.process(claim);
    } finally {
      this.inFlight = undefined;
    }
  }

  private async process(claim: ErasureClaim): Promise<ErasureWorkOutcome> {
    let request = claim.request;
    let step = `resume while ${request.state}`;
    try {
      if (claim.attempts > this.maxAttempts) {
        // Every earlier pass went stale without landing a terminal state: stop retaking; a new request has to finish the job.
        console.error(`erasure ${request.id}: claim went stale ${claim.attempts - 1} time(s) while ${request.state}; giving up`);
        await this.markFailed(request, claim, { kind: "StaleClaim", reason: `abandoned by the worker after ${claim.attempts - 1} stale claim(s) while ${request.state}` });
        return "failed";
      }
      const final = await this.run(claim, (r) => (request = r), (s) => (step = s));
      return final.state === "receipted" ? "receipted" : "failed";
    } catch (e) {
      if (e instanceof ErasureReleased) {
        console.error(`erasure ${request.id}: released while ${request.state} (worker stopping); the next pass resumes it`);
        return "released";
      }
      if (isLost(e)) return this.lost(request, step, e);
      console.error(`erasure ${request.id}: ${step} failed`, e);
      try {
        await this.markFailed(request, claim, { kind: errorKind(e), reason: `${step} failed (${errorKind(e)})` });
      } catch (saveError) {
        // The request was retaken or abandoned between the failing step and this save: the stored row wins.
        if (isLost(saveError)) return this.lost(request, `${step} (marking failed)`, saveError);
        throw saveError;
      }
      return "failed";
    }
  }

  private lost(request: ErasureRequest, step: string, e: Error): "lost" {
    // An operator abandoned the request, or this pass went stale and another took it: nothing further runs here.
    console.error(`erasure ${request.id}: ${step} finished after this pass lost the request (${e.name}); no further step runs`);
    return "lost";
  }

  /** Between steps: a stopping worker hands the row back instead of starting the next step. */
  private async checkpoint(claim: ErasureClaim): Promise<void> {
    if (!this.stopping) return;
    try {
      await this.requests.release(claim);
    } catch (e) {
      // Shutdown is when connections drop; a release that fails only means the claim goes stale and is retaken later. Never a failed request.
      console.error(`erasure ${claim.request.id}: release failed (${e instanceof Error ? e.name : typeof e}); the claim will go stale instead`);
    }
    throw new ErasureReleased();
  }

  private async run(claim: ErasureClaim, track: (r: ErasureRequest) => void, at: (step: string) => void): Promise<ErasureRequest> {
    let request = claim.request;
    const bankId = request.bankId;
    const engines = wiredEngines(this.stores);

    if (request.state === "requested" || request.state === "inventoried" || request.state === "deleted") {
      at(request.state === "requested" ? "freeze" : `freeze (resumed while ${request.state})`);
      const frozen = await this.bank.beginErasure(bankId);
      // Re-read under the row lock: a `reindex` that moved the bank between the pre-check and the freeze must not be purged from the wrong engine.
      if (!engines.includes(frozen.engine)) throw new EngineMismatchError(frozen.engine, engines);
    }

    if (request.state === "requested") {
      at("inventory");
      const inventory: StoreInventory[] = [];
      for (const store of this.stores) {
        for (const [name, countBefore] of Object.entries(await store.count(bankId))) inventory.push({ store: name, countBefore });
      }
      request = unwrap(recordInventory(request, inventory));
      track(request);
      await this.save(request, claim);
    }

    if (request.state === "inventoried") {
      const resumed = request.deletions.length > 0;
      for (const [i, store] of this.stores.entries()) {
        at(`purge of store ${i + 1} of ${this.stores.length}`);
        await this.checkpoint(claim);
        if (resumed && (await this.alreadyPurged(store, request))) continue;
        const purged = Object.entries(await store.purge(bankId, { id: request.id })).map(([name, p]) => [name, normalize(p)] as const);
        const deletedAt = this.clock.now();
        for (const [name, p] of purged) request = unwrap(recordDeletion(request, { store: name, deleted: p.deleted, deletedAt, ...(p.evidence ? { evidence: p.evidence } : {}) }));
        track(request);
        const saved = request;
        const action = store.auditPurgeAs;
        await this.uow.run(async (tx) => {
          await tx.requests.save(saved, { claimToken: claim.token });
          // Counts per name plus whatever evidence the purge named (ids only), each key prefixed with its store name so nothing can shadow the workflow's own keys.
          if (action) {
            const details: Record<string, number | readonly string[]> = Object.fromEntries(purged.map(([name, p]) => [`deleted.${name}`, p.deleted]));
            for (const [name, p] of purged) for (const [key, ids] of Object.entries(p.evidence ?? {})) details[`${name}.${key}`] = ids;
            await tx.audit.append(this.entry(saved, action, details, deletedAt));
          }
        });
      }
      at("deleted");
      request = unwrap(markDeleted(request));
      track(request);
      const deletedRequest = request;
      await this.uow.run(async (tx) => {
        await tx.requests.save(deletedRequest, { claimToken: claim.token });
        await tx.audit.append(this.entry(deletedRequest, "erasure.deleted", Object.fromEntries(deletedRequest.deletions.map((d) => [`deleted.${d.store}`, d.deleted]))));
      });
    }

    if (request.state === "deleted") {
      at("verify");
      await this.checkpoint(claim);
      const verifications: StoreVerification[] = [];
      for (const store of this.stores) {
        const checkedAt = this.clock.now();
        for (const [name, hitsAfter] of Object.entries(await store.count(bankId, { requestId: request.id, deletions: request.deletions }))) verifications.push({ store: name, hitsAfter, checkedAt });
      }
      const verified = recordVerification(request, verifications);
      if (!verified.ok) {
        const stores = verified.error.kind === "VerificationFailed" ? verified.error.stores : [];
        return this.markFailed(request, claim, { kind: "VerificationFailed", reason: `verification failed: ${stores.join(", ")} still report data`, stores }, verifications);
      }
      request = verified.value;
      track(request);
      const verifiedRequest = request;
      await this.uow.run(async (tx) => {
        await tx.requests.save(verifiedRequest, { claimToken: claim.token });
        await tx.audit.append(this.entry(verifiedRequest, "erasure.verified", { stores: verifiedRequest.verifications.map((v) => v.store) }));
      });
    }

    if (request.state === "verified") {
      at("tombstone");
      await this.checkpoint(claim);
      await this.bank.completeErasure(bankId);
      at("receipt");
      const receipted = unwrap(issueReceipt(request, this.clock.now(), this.hash));
      const receipt = receipted.receipt!;
      await this.uow.run(async (tx) => {
        await tx.requests.save(receipted, { claimToken: claim.token });
        await tx.audit.append(this.entry(receipted, "erasure.receipt_issued", { digest: receipt.digest, stores: receipt.stores.map((s) => s.store) }, receipt.issuedAt));
      });
      track(receipted);
      return receipted;
    }

    throw new Error(`erasure state machine: cannot resume a request in state ${request.state}`);
  }

  /**
   * On a resumed pass: every name the store reports is already in the recorded deletions, so the dead pass purged and
   * saved it. This trusts that nothing re-populated the store since (the gap is up to `staleAfterMs`, not seconds);
   * if something did, the verify step still fails closed.
   */
  private async alreadyPurged(store: ErasableStore, request: ErasureRequest): Promise<boolean> {
    const recorded = new Set(request.deletions.map((d) => d.store));
    const names = Object.keys(await store.count(request.bankId));
    return names.length > 0 && names.every((n) => recorded.has(n));
  }

  private save(request: ErasureRequest, claim: ErasureClaim): Promise<void> {
    return this.uow.run((tx) => tx.requests.save(request, { claimToken: claim.token }));
  }

  private async markFailed(request: ErasureRequest, claim: ErasureClaim, cause: FailureCause, verifications?: readonly StoreVerification[]): Promise<ErasureRequest> {
    const failed = fail(request, cause.reason, verifications);
    await this.uow.run(async (tx) => {
      await tx.requests.save(failed, { claimToken: claim.token });
      await tx.audit.append(this.entry(failed, "erasure.failed", { kind: cause.kind, ...(cause.stores ? { stores: cause.stores } : {}) }));
    });
    return failed;
  }

  private entry(request: ErasureRequest, action: AuditEntry["action"], details: AuditEntry["details"], at: Date = this.clock.now()): Omit<AuditEntry, "seq" | "prevHash" | "hash"> {
    return { tenantId: request.tenantId, bankId: request.bankId, principalId: request.requestedBy, action, details: { requestId: request.id, ...details }, at };
  }
}

interface FailureCause {
  /** Error class name (with the SQLSTATE for database errors) or domain error kind: safe for the audit log. */
  readonly kind: string;
  /** Bounded operator summary for the request row: step and kind, or the stores that failed verification. */
  readonly reason: string;
  readonly stores?: readonly string[];
}

const normalize = (p: StorePurge): { readonly deleted: number; readonly evidence?: Readonly<Record<string, readonly string[]>> } => (typeof p === "number" ? { deleted: p } : p);

const isLost = (e: unknown): e is Error => e instanceof ErasureNotInFlightError || e instanceof ErasureClaimLostError;

/** Thrown by `checkpoint` after the row was handed back: unwinds the pass without marking anything. */
class ErasureReleased extends Error {
  constructor() {
    super("erasure worker stopping");
    this.name = "ErasureReleased";
  }
}

/** The bank's recorded engine changed between the pre-check and the freeze. Its `name` is the error kind the audit log gets. */
class EngineMismatchError extends Error {
  constructor(bankEngine: string, serverEngines: readonly string[]) {
    super(`bank records engine "${bankEngine}", wired stores purge ${serverEngines.join(", ") || "none"}`);
    this.name = "EngineMismatch";
  }
}

function unwrap<T>(r: Result<T, { readonly kind: string }>): T {
  if (!r.ok) throw new Error(`erasure state machine: ${JSON.stringify(r.error)}`);
  return r.value;
}

/** Class name, plus the SQLSTATE for pg errors (whose `name` is just "error"). Never the message. */
const errorKind = (e: unknown): string => {
  if (!(e instanceof Error)) return typeof e;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" ? `${e.name}/${code}` : e.name;
};

