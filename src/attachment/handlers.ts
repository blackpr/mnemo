import { randomUUID } from "node:crypto";
import type { BankId, Clock, Scope } from "../shared-kernel/index.js";
import { sha256 } from "../platform/hash.js";
import { EraseBankHandler, GetErasureHandler, type AccessPolicy, type AuditLogStore, type ErasableStore, type ErasureBankGateway, type ErasureRequestRepository, type ErasureUnitOfWork, type ScopeResolver } from "../governance/index.js";
import type { BankRepository } from "../memory/index.js";
import { ExportBankHandler, type ExportStore } from "../portability/index.js";
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
  readonly banks: BankRepository;
  readonly facts: FactRepository;
  readonly episodes: EpisodeRepository;
  readonly finder: MemoryFinder;
  readonly exports: ExportStore;
  readonly erasure: ErasureDeps;
}

/**
 * The Erasure workflow's view of the system: the bank gateway, the request store (reads), the unit of
 * work (request writes + audit, atomic) and every store holding Subject data, Memory first (its purge
 * drops the outbox events whose consumers write into the stores purged after it).
 */
export interface ErasureDeps {
  readonly bank: ErasureBankGateway;
  readonly requests: ErasureRequestRepository;
  readonly uow: ErasureUnitOfWork;
  readonly stores: readonly ErasableStore[];
}

export interface Handlers {
  readonly recordEpisode: RecordEpisodeHandler;
  readonly recall: RecallHandler;
  readonly assertFact: AssertFactHandler;
  readonly listFacts: ListFactsHandler;
  readonly getFact: GetFactHandler;
  readonly setConfirmation: SetConfirmationHandler;
  readonly exportBank: ExportBankHandler;
  readonly eraseBank: EraseBankHandler;
  readonly getErasure: GetErasureHandler;
}

export function buildHandlers(deps: AttachmentDeps): Handlers {
  return {
    recordEpisode: new RecordEpisodeHandler(deps.uow, deps.access, deps.clock),
    recall: new RecallHandler(deps.finder, deps.facts, deps.episodes, deps.access, deps.audit, deps.clock),
    assertFact: new AssertFactHandler(deps.uow, deps.access, deps.clock),
    listFacts: new ListFactsHandler(deps.facts, deps.access, deps.audit, deps.clock),
    getFact: new GetFactHandler(deps.facts, deps.access, deps.audit, deps.clock),
    setConfirmation: new SetConfirmationHandler(deps.uow, deps.access, deps.clock),
    exportBank: new ExportBankHandler(deps.banks, deps.facts, deps.access, deps.exports, deps.audit, deps.clock),
    eraseBank: new EraseBankHandler(deps.access, deps.erasure.bank, deps.erasure.uow, deps.erasure.stores, deps.clock, randomUUID, sha256),
    getErasure: new GetErasureHandler(deps.access, deps.erasure.requests),
  };
}

export type AppError = { readonly kind: string };

/** Capability denials are the one thing handlers do not audit themselves (they return before any write). */
export async function auditDenial(deps: AttachmentDeps, scope: Scope, bankId: BankId, error: AppError): Promise<void> {
  if (error.kind !== "AccessDenied") return;
  const required = String((error as AppError & { required?: unknown }).required);
  await deps.audit.append({ tenantId: scope.tenantId, bankId, principalId: scope.principalId, action: "access.denied", details: { required, via: "attachment" }, at: deps.clock.now() });
}
