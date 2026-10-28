import type { BankId, Clock, Result, Scope } from "../../shared-kernel/index.js";
import { err, ok } from "../../shared-kernel/index.js";
import type { AccessDenied, AccessPolicy } from "../domain/access-policy.js";
import { requestErasure, type ErasureRequest } from "../domain/erasure-request.js";
import { ErasureInFlightError, type ErasableStore, type ErasureBankGateway, type ErasureRequestRepository, type ErasureUnitOfWork } from "../ports/repositories.js";

export type EraseBankError =
  | AccessDenied
  | { readonly kind: "BankNotFound" }
  | { readonly kind: "ErasureInFlight"; readonly bankId: BankId }
  /** The bank records its index in a retrieval engine none of the wired stores purges: refused before anything is written. */
  | { readonly kind: "EngineMismatch"; readonly bankEngine: string; readonly serverEngines: readonly string[] };

export type ErasureStatusError = AccessDenied | { readonly kind: "ErasureNotFound"; readonly requestId: string };

const TERMINAL = new Set(["receipted", "failed"]);

/**
 * Request the erasure of a Bank: the one operation that removes data from the system of record.
 *
 * This handler only enqueues (ARCHITECTURE.md 2.2 and 6):
 *   1. `erase` capability on the bank, bank exists in the scope's tenant, and the bank's recorded retrieval
 *      engine is one a wired store purges (`ErasableStore.engine`); otherwise `EngineMismatch`, so an erasure
 *      can never purge the wrong engine and receipt a bank whose index lives elsewhere.
 *   2. In one transaction: the request row is created (`requested`; the database refuses a second
 *      in-flight one for the bank) and the `erasure.requested` audit entry is written. If the audit
 *      write fails, the request row rolls back with it and nothing has been touched.
 * The request is returned as `requested`; the `ErasureWorker` (a loop in the server process) claims it and
 * runs the workflow: freeze, inventory, purge, verify, tombstone, receipt. The request id is the handle:
 * `GetErasureHandler` / `GET /v1/banks/:bankId/erasure/:id` / `admin erasure-status` show where it stands.
 */
export class EraseBankHandler {
  constructor(
    private readonly access: AccessPolicy,
    private readonly bank: ErasureBankGateway,
    private readonly uow: ErasureUnitOfWork,
    private readonly stores: readonly ErasableStore[],
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}

  async handle(scope: Scope, bankId: BankId): Promise<Result<ErasureRequest, EraseBankError>> {
    const allowed = this.access.canErase(scope, bankId);
    if (!allowed.ok) return allowed;
    const bank = await this.bank.describe(bankId);
    if (!bank) return err({ kind: "BankNotFound" } as const);
    if (bank.tenantId !== scope.tenantId) return err({ kind: "AccessDenied", bankId, required: "erase" } as const);
    const engines = wiredEngines(this.stores);
    if (!engines.includes(bank.engine)) return err({ kind: "EngineMismatch", bankEngine: bank.engine, serverEngines: engines } as const);

    const request = requestErasure({ id: this.newId(), tenantId: scope.tenantId, bankId, subjectId: bank.subjectId, requestedBy: scope.principalId, requestedAt: this.clock.now() });
    try {
      // Audit before the destructive action, atomically with the request record.
      await this.uow.run(async (tx) => {
        await tx.requests.create(request);
        await tx.audit.append({ tenantId: scope.tenantId, bankId, principalId: scope.principalId, action: "erasure.requested", details: { requestId: request.id, subjectId: bank.subjectId }, at: request.requestedAt });
      });
    } catch (e) {
      if (e instanceof ErasureInFlightError) return err({ kind: "ErasureInFlight", bankId } as const);
      throw e;
    }
    return ok(request);
  }
}

/** The engines the wired stores purge, taken from the stores themselves so the check can never disagree with what is purged. */
export function wiredEngines(stores: readonly ErasableStore[]): readonly string[] {
  return stores.flatMap((s) => (s.engine !== undefined ? [s.engine] : []));
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
  | { readonly kind: "ErasureStillRunning"; readonly updatedAt: Date; readonly staleAfterMs: number }
  /** `force` was given, but the row moved on (a step landed) every time the abandon tried to apply: a pass is clearly running it. */
  | { readonly kind: "ErasureKeepsMoving"; readonly state: ErasureRequest["state"] };

/**
 * Operator recovery: a request stuck in a non-terminal state that the worker will not finish (no server runs
 * the worker, or the worker keeps dying on it and has not yet given up) blocks every later erasure of its
 * bank and keeps the bank frozen. Abandoning it marks it `failed` with an `erasure.failed` audit entry; a new
 * request can then redo the job. Nothing is un-deleted, nothing is deleted. A request whose row changed
 * (any step landed, or a pass claimed it) less than `staleAfterMs` ago is presumed still running and refused
 * unless `force` is given, and the check is repeated in the update itself (`ErasureRequestRepository.abandon`, a
 * compare-and-set on the state read and, without `force`, on the row still being stale), so a step landing between the
 * read and the write is never lost: the update writes only the state and the failure, never the request read here.
 * If a running pass does lose the race, its next save fails (terminal rows are never overwritten) and it stops.
 * A crash alone no longer needs this: the worker retakes a stale claim by itself.
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
    // The row is read for the checks and the message, but never written back: the repository's compare-and-set touches only state and
    // failure, so a deletion the worker saves after this read stays recorded. A miss (the row moved on) re-reads and re-checks.
    for (let attempt = 1; ; attempt++) {
      const request = await this.requests.get(requestId, { bankId, tenantId: scope.tenantId });
      if (!request) return err({ kind: "ErasureNotFound", requestId } as const);
      if (TERMINAL.has(request.state)) return err({ kind: "ErasureTerminal", state: request.state } as const);
      const updatedAt = request.updatedAt ?? request.requestedAt;
      const stillRunning = { kind: "ErasureStillRunning", updatedAt, staleAfterMs: this.staleAfterMs } as const;
      if (!opts.force && this.clock.now().getTime() - updatedAt.getTime() < this.staleAfterMs) return err(stillRunning);
      const failure = `abandoned while ${request.state}: ${reason}`.slice(0, 500);
      const abandoned = await this.uow.run(async (tx) => {
        const stored = await tx.requests.abandon(request, failure, { state: request.state, ...(opts.force ? {} : { unchangedForMs: this.staleAfterMs }) });
        if (stored) await tx.audit.append({ tenantId: scope.tenantId, bankId, principalId: scope.principalId, action: "erasure.failed", details: { requestId, kind: "Abandoned", from: request.state }, at: this.clock.now() });
        return stored;
      });
      if (abandoned) return ok(abandoned);
      // A pass that keeps landing steps: give up after a few rounds rather than chase it.
      if (attempt >= 3) return err(opts.force ? ({ kind: "ErasureKeepsMoving", state: request.state } as const) : stillRunning);
    }
  }
}
