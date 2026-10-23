import type { BankId, Clock, Result, Scope } from "../../shared-kernel/index.js";
import { err, ok } from "../../shared-kernel/index.js";
import type { AccessDenied, AccessPolicy } from "../domain/access-policy.js";
import type { AuditEntry, Hasher } from "../domain/audit-log.js";
import {
  fail,
  issueReceipt,
  markDeleted,
  recordDeletion,
  recordInventory,
  recordVerification,
  requestErasure,
  type ErasureRequest,
  type StoreInventory,
  type StoreVerification,
} from "../domain/erasure-request.js";
import { ErasureInFlightError, ErasureNotInFlightError, type ErasableStore, type ErasureBankGateway, type ErasureRequestRepository, type ErasureUnitOfWork } from "../ports/repositories.js";

export type EraseBankError = AccessDenied | { readonly kind: "BankNotFound" } | { readonly kind: "ErasureInFlight"; readonly bankId: BankId };

export type ErasureStatusError = AccessDenied | { readonly kind: "ErasureNotFound"; readonly requestId: string };

const TERMINAL = new Set(["receipted", "failed"]);

/**
 * Erase a Bank: the one operation that removes data from the system of record.
 *
 * Order of events (ARCHITECTURE.md 2.2 and 6):
 *   1. `erase` capability on the bank, bank exists in the scope's tenant.
 *   2. In one transaction: the request row is created (`requested`; the database refuses a second
 *      in-flight one for the bank) and the `erasure.requested` audit entry is written. If the audit
 *      write fails, the request row rolls back with it and nothing has been touched.
 *   3. The bank is frozen (`erasing`) under a row lock: writers that already passed their status check
 *      finish first, later ones are refused, so no write can slip in while stores are being purged.
 *   4. Inventory: every store counts what it holds. Delete: every store purges, one at a time, each
 *      deletion saved on the request before the next store starts. Verify: every store counts again;
 *      any hit, or any inventoried store that did not report, fails closed.
 *   5. Only then: the bank becomes a tombstone (`erased`), and in one transaction the receipt is saved
 *      and its digest goes into the audit chain (`erasure.receipt_issued`).
 * Any failure leaves the request `failed` with the reason and whatever was deleted recorded per
 * store; the bank stays frozen so a retry (a new request) can finish the job. Neither the audit log nor
 * the request row carries a store's raw error text (it may echo content or infrastructure details): they
 * get the step and the error kind; the text goes to the process log.
 */
export class EraseBankHandler {
  constructor(
    private readonly access: AccessPolicy,
    private readonly bank: ErasureBankGateway,
    private readonly uow: ErasureUnitOfWork,
    private readonly stores: readonly ErasableStore[],
    private readonly clock: Clock,
    private readonly newId: () => string,
    private readonly hash: Hasher,
  ) {}

  async handle(scope: Scope, bankId: BankId): Promise<Result<ErasureRequest, EraseBankError>> {
    const allowed = this.access.canErase(scope, bankId);
    if (!allowed.ok) return allowed;
    const bank = await this.bank.describe(bankId);
    if (!bank) return err({ kind: "BankNotFound" } as const);
    if (bank.tenantId !== scope.tenantId) return err({ kind: "AccessDenied", bankId, required: "erase" } as const);

    const request = requestErasure({ id: this.newId(), tenantId: scope.tenantId, bankId, subjectId: bank.subjectId, requestedBy: scope.principalId, requestedAt: this.clock.now() });
    try {
      // Audit before the destructive action, atomically with the request record.
      await this.uow.run(async (tx) => {
        await tx.requests.create(request);
        await tx.audit.append(this.entry(scope, request, "erasure.requested", { subjectId: bank.subjectId }, request.requestedAt));
      });
    } catch (e) {
      if (e instanceof ErasureInFlightError) return err({ kind: "ErasureInFlight", bankId } as const);
      throw e;
    }
    return ok(await this.run(request, scope));
  }

  /** Every step after the audit entry. Whatever state the request reached when a step throws is what gets marked failed, deletions included. */
  private async run(initial: ErasureRequest, scope: Scope): Promise<ErasureRequest> {
    let request = initial;
    let step = "freeze";
    try {
      return await this.erase(request, scope, (r) => (request = r), (s) => (step = s));
    } catch (e) {
      if (e instanceof ErasureNotInFlightError) {
        // An operator abandoned the request while it was running (or it was raced): the stored row wins.
        console.error(`erasure ${request.id}: ${step} finished after the request was closed; no further step runs`, e.message);
        return (await this.uow.run((tx) => tx.requests.get(request.id))) ?? request;
      }
      console.error(`erasure ${request.id}: ${step} failed`, e);
      return this.markFailed(request, scope, { kind: errorKind(e), reason: `${step} failed (${errorKind(e)})` });
    }
  }

  private async erase(initial: ErasureRequest, scope: Scope, track: (r: ErasureRequest) => void, at: (step: string) => void): Promise<ErasureRequest> {
    const bankId = initial.bankId;
    at("freeze");
    await this.bank.beginErasure(bankId);

    at("inventory");
    const inventory: StoreInventory[] = [];
    for (const store of this.stores) {
      for (const [name, countBefore] of Object.entries(await store.count(bankId))) inventory.push({ store: name, countBefore });
    }
    let request = unwrap(recordInventory(initial, inventory));
    track(request);
    await this.save(request);

    for (const [i, store] of this.stores.entries()) {
      at(`purge of store ${i + 1} of ${this.stores.length}`);
      const deleted = await store.purge(bankId);
      const deletedAt = this.clock.now();
      for (const [name, n] of Object.entries(deleted)) request = unwrap(recordDeletion(request, { store: name, deleted: n, deletedAt }));
      track(request);
      await this.save(request);
    }
    at("deleted");
    request = unwrap(markDeleted(request));
    track(request);
    await this.uow.run(async (tx) => {
      await tx.requests.save(request);
      await tx.audit.append(this.entry(scope, request, "erasure.deleted", Object.fromEntries(request.deletions.map((d) => [`deleted.${d.store}`, d.deleted]))));
    });

    at("verify");
    const verifications: StoreVerification[] = [];
    for (const store of this.stores) {
      const checkedAt = this.clock.now();
      for (const [name, hitsAfter] of Object.entries(await store.count(bankId))) verifications.push({ store: name, hitsAfter, checkedAt });
    }
    const verified = recordVerification(request, verifications);
    if (!verified.ok) {
      const stores = verified.error.kind === "VerificationFailed" ? verified.error.stores : [];
      return this.markFailed(request, scope, { kind: "VerificationFailed", reason: `verification failed: ${stores.join(", ")} still report data`, stores }, verifications);
    }
    request = verified.value;
    track(request);
    await this.uow.run(async (tx) => {
      await tx.requests.save(request);
      await tx.audit.append(this.entry(scope, request, "erasure.verified", { stores: request.verifications.map((v) => v.store) }));
    });

    at("tombstone");
    await this.bank.completeErasure(bankId);
    at("receipt");
    const receipted = unwrap(issueReceipt(request, this.clock.now(), this.hash));
    const receipt = receipted.receipt!;
    await this.uow.run(async (tx) => {
      await tx.requests.save(receipted);
      await tx.audit.append(this.entry(scope, receipted, "erasure.receipt_issued", { digest: receipt.digest, stores: receipt.stores.map((s) => s.store) }, receipt.issuedAt));
    });
    track(receipted);
    return receipted;
  }

  private save(request: ErasureRequest): Promise<void> {
    return this.uow.run((tx) => tx.requests.save(request));
  }

  private async markFailed(request: ErasureRequest, scope: Scope, cause: FailureCause, verifications?: readonly StoreVerification[]): Promise<ErasureRequest> {
    const failed = fail(request, cause.reason, verifications);
    await this.uow.run(async (tx) => {
      await tx.requests.save(failed);
      await tx.audit.append(this.entry(scope, failed, "erasure.failed", { kind: cause.kind, ...(cause.stores ? { stores: cause.stores } : {}) }));
    });
    return failed;
  }

  private entry(scope: Scope, request: ErasureRequest, action: AuditEntry["action"], details: AuditEntry["details"], at: Date = this.clock.now()): Omit<AuditEntry, "seq" | "prevHash" | "hash"> {
    return { tenantId: scope.tenantId, bankId: request.bankId, principalId: scope.principalId, action, details: { requestId: request.id, ...details }, at };
  }
}

interface FailureCause {
  /** Error class name (with the SQLSTATE for database errors) or domain error kind: safe for the audit log. */
  readonly kind: string;
  /** Bounded operator summary for the request row: step and kind, or the stores that failed verification. */
  readonly reason: string;
  readonly stores?: readonly string[];
}

/** Read one request. Needs the `erase` capability on the bank it belongs to; a request of another bank or tenant is not found. */
export class GetErasureHandler {
  constructor(
    private readonly access: AccessPolicy,
    private readonly requests: ErasureRequestRepository,
  ) {}

  async handle(scope: Scope, bankId: BankId, requestId: string): Promise<Result<ErasureRequest, ErasureStatusError>> {
    const allowed = this.access.canErase(scope, bankId);
    if (!allowed.ok) return allowed;
    const request = await this.requests.get(requestId, { bankId, tenantId: scope.tenantId });
    if (!request) return err({ kind: "ErasureNotFound", requestId } as const);
    return ok(request);
  }
}

export type AbandonErasureError =
  | AccessDenied
  | { readonly kind: "ErasureNotFound"; readonly requestId: string }
  | { readonly kind: "ErasureTerminal"; readonly state: ErasureRequest["state"] }
  | { readonly kind: "ErasureStillRunning"; readonly updatedAt: Date; readonly staleAfterMs: number };

/**
 * Operator recovery: a request stuck in a non-terminal state (the process died mid-workflow, or the
 * terminal save failed) blocks every later erasure of its bank and keeps the bank frozen. Abandoning
 * it marks it `failed` with an `erasure.failed` audit entry; a new request can then redo the job.
 * Nothing is un-deleted, nothing is deleted. A request whose row changed less than `staleAfterMs` ago
 * is presumed still running and refused unless `force` is given; if a running workflow does lose the
 * race, its next save fails (terminal rows are never overwritten) and it stops.
 */
export class AbandonErasureHandler {
  constructor(
    private readonly access: AccessPolicy,
    private readonly requests: ErasureRequestRepository,
    private readonly uow: ErasureUnitOfWork,
    private readonly clock: Clock,
    private readonly staleAfterMs = 10 * 60_000,
  ) {}

  async handle(scope: Scope, bankId: BankId, requestId: string, reason: string, opts: { readonly force?: boolean } = {}): Promise<Result<ErasureRequest, AbandonErasureError>> {
    const allowed = this.access.canErase(scope, bankId);
    if (!allowed.ok) return allowed;
    const request = await this.requests.get(requestId, { bankId, tenantId: scope.tenantId });
    if (!request) return err({ kind: "ErasureNotFound", requestId } as const);
    if (TERMINAL.has(request.state)) return err({ kind: "ErasureTerminal", state: request.state } as const);
    const updatedAt = request.updatedAt ?? request.requestedAt;
    if (!opts.force && this.clock.now().getTime() - updatedAt.getTime() < this.staleAfterMs) return err({ kind: "ErasureStillRunning", updatedAt, staleAfterMs: this.staleAfterMs } as const);
    const failed = fail(request, `abandoned while ${request.state}: ${reason}`.slice(0, 500));
    await this.uow.run(async (tx) => {
      await tx.requests.save(failed);
      await tx.audit.append({ tenantId: scope.tenantId, bankId, principalId: scope.principalId, action: "erasure.failed", details: { requestId, kind: "Abandoned", from: request.state }, at: this.clock.now() });
    });
    return ok(failed);
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
