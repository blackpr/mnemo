import type { BankId, Clock, FactId, Result, Scope } from "../../shared-kernel/index.js";
import { err, ok } from "../../shared-kernel/index.js";
import type { AccessDenied, AccessPolicy, AuditLogStore } from "../../governance/index.js";
import { confirm, dispute, type Fact, type FactError } from "../domain/fact.js";
import type { FactConfirmed, FactDisputed } from "../domain/events.js";
import type { FactRepository, UnitOfWork } from "../ports/repositories.js";

export type FactNotFound = { readonly kind: "FactNotFound"; readonly factId: FactId };

/** Reads audit what was served (ids only) so an erasure receipt can say who read what. */
export class ListFactsHandler {
  constructor(
    private readonly facts: FactRepository,
    private readonly access: AccessPolicy,
    private readonly audit: AuditLogStore,
    private readonly clock: Clock,
  ) {}

  async handle(scope: Scope, bankId: BankId, opts: { readonly asOf?: Date } = {}): Promise<Result<readonly Fact[], AccessDenied>> {
    const allowed = this.access.canRead(scope, bankId);
    if (!allowed.ok) return allowed;
    const facts = await this.facts.listCurrent(scope, opts.asOf);
    await this.audit.append({ tenantId: scope.tenantId, bankId, principalId: scope.principalId, action: "facts.listed", details: { count: facts.length, ...(opts.asOf ? { asOf: opts.asOf.toISOString() } : {}) }, at: this.clock.now() });
    return ok(facts);
  }
}

export class GetFactHandler {
  constructor(
    private readonly facts: FactRepository,
    private readonly access: AccessPolicy,
    private readonly audit: AuditLogStore,
    private readonly clock: Clock,
  ) {}

  /** GET by id goes through the same policy as search. No bypass path. */
  async handle(scope: Scope, bankId: BankId, factId: FactId): Promise<Result<Fact, AccessDenied | FactNotFound>> {
    const allowed = this.access.canRead(scope, bankId);
    if (!allowed.ok) return allowed;
    const fact = await this.facts.get(scope, factId);
    if (!fact) return err({ kind: "FactNotFound", factId });
    await this.audit.append({ tenantId: scope.tenantId, bankId, principalId: scope.principalId, action: "fact.read", details: { factId }, at: this.clock.now() });
    return ok(fact);
  }
}

export type Confirmation = "confirmed" | "disputed";

/**
 * The Subject (or a trusted principal) confirms or disputes a fact. Changes provenance state only.
 * The row is locked for the transaction so a concurrent supersession cannot be overwritten by a
 * stale copy.
 */
export class SetConfirmationHandler {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessPolicy,
    private readonly clock: Clock,
  ) {}

  async handle(scope: Scope, bankId: BankId, factId: FactId, state: Confirmation): Promise<Result<Fact, AccessDenied | FactNotFound | FactError>> {
    const allowed = this.access.canWrite(scope, bankId);
    if (!allowed.ok) return allowed;

    return this.uow.run(async (tx) => {
      const fact = await tx.facts.get(scope, factId, { forUpdate: true });
      if (!fact) return err({ kind: "FactNotFound", factId } as const);
      const updated = state === "confirmed" ? confirm(fact) : dispute(fact);
      if (!updated.ok) return updated;
      await tx.facts.update(updated.value);
      const now = this.clock.now();
      const event: FactConfirmed | FactDisputed =
        state === "confirmed"
          ? { type: "memory.FactConfirmed", occurredAt: now, tenantId: scope.tenantId, bankId, payload: { factId } }
          : { type: "memory.FactDisputed", occurredAt: now, tenantId: scope.tenantId, bankId, payload: { factId } };
      await tx.outbox.publish([event]);
      await tx.audit.append({ tenantId: scope.tenantId, bankId, principalId: scope.principalId, action: state === "confirmed" ? "fact.confirmed" : "fact.disputed", details: { factId }, at: now });
      return ok(updated.value);
    });
  }
}
