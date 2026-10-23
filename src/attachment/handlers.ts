import type { BankId, Clock, Scope } from "../shared-kernel/index.js";
import type { AccessPolicy, AuditLogStore, ScopeResolver } from "../governance/index.js";
import {
  AssertFactHandler,
  GetFactHandler,
  ListFactsHandler,
  RecallHandler,
  RecordEpisodeHandler,
  SetConfirmationHandler,
  type EpisodeRepository,
  type FactRepository,
  type MemoryFinder,
  type UnitOfWork,
} from "../memory/index.js";

/**
 * Everything an attachment needs. REST and MCP build the same application handlers from the
 * same dependencies, so the two surfaces cannot diverge in behaviour or auditing.
 */
export interface AttachmentDeps {
  readonly scopes: ScopeResolver;
  readonly access: AccessPolicy;
  readonly audit: AuditLogStore;
  readonly clock: Clock;
  readonly uow: UnitOfWork;
  readonly facts: FactRepository;
  readonly episodes: EpisodeRepository;
  readonly finder: MemoryFinder;
}

export interface Handlers {
  readonly recordEpisode: RecordEpisodeHandler;
  readonly recall: RecallHandler;
  readonly assertFact: AssertFactHandler;
  readonly listFacts: ListFactsHandler;
  readonly getFact: GetFactHandler;
  readonly setConfirmation: SetConfirmationHandler;
}

export function buildHandlers(deps: AttachmentDeps): Handlers {
  return {
    recordEpisode: new RecordEpisodeHandler(deps.uow, deps.access, deps.clock),
    recall: new RecallHandler(deps.finder, deps.facts, deps.episodes, deps.access, deps.audit, deps.clock),
    assertFact: new AssertFactHandler(deps.uow, deps.access, deps.clock),
    listFacts: new ListFactsHandler(deps.facts, deps.access, deps.audit, deps.clock),
    getFact: new GetFactHandler(deps.facts, deps.access, deps.audit, deps.clock),
    setConfirmation: new SetConfirmationHandler(deps.uow, deps.access, deps.clock),
  };
}

export type AppError = { readonly kind: string };

/** Capability denials are the one thing handlers do not audit themselves (they return before any write). */
export async function auditDenial(deps: AttachmentDeps, scope: Scope, bankId: BankId, error: AppError): Promise<void> {
  if (error.kind !== "AccessDenied") return;
  const required = String((error as AppError & { required?: unknown }).required);
  await deps.audit.append({ tenantId: scope.tenantId, bankId, principalId: scope.principalId, action: "access.denied", details: { required, via: "attachment" }, at: deps.clock.now() });
}
