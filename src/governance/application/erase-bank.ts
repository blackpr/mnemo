import type { BankId, Clock, Result, Scope } from "../../shared-kernel/index.js";
import { err, ok } from "../../shared-kernel/index.js";
import type { AccessDenied, AccessPolicy } from "../domain/access-policy.js";
import { fail, requestErasure, type ErasureRequest } from "../domain/erasure-request.js";
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
  | { readonly kind: "ErasureStillRunning"; readonly updatedAt: Date; readonly staleAfterMs: number };

/**
 * Operator recovery: a request stuck in a non-terminal state that the worker will not finish (no server runs
 * the worker, or the worker keeps dying on it and has not yet given up) blocks every later erasure of its
 * bank and keeps the bank frozen. Abandoning it marks it `failed` with an `erasure.failed` audit entry; a new
 * request can then redo the job. Nothing is un-deleted, nothing is deleted. A request whose row changed
 * (any step landed, or a pass claimed it) less than `staleAfterMs` ago is presumed still running and refused
 * unless `force` is given; if a running pass does lose the race, its next save fails (terminal rows are never
 * overwritten) and it stops. A crash alone no longer needs this: the worker retakes a stale claim by itself.
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
