import type { BankId, Clock, EpisodeId, FactId, Result, Scope } from "../../shared-kernel/index.js";
import { err, ok } from "../../shared-kernel/index.js";
import type { AccessDenied, AccessPolicy } from "../../governance/index.js";
import { canAcceptWrites } from "../domain/bank.js";
import { assertFact, type Fact, type FactError } from "../domain/fact.js";
import type { FactAsserted } from "../domain/events.js";
import { DuplicateFactError, type UnitOfWork } from "../ports/repositories.js";

export interface AssertFactInput {
  readonly id: FactId;
  readonly bankId: BankId;
  readonly statement: string;
  readonly predicate?: Fact["predicate"];
  readonly validFrom?: Date;
  /** Must exist in the same bank. At least one. */
  readonly sourceEpisodeIds: readonly EpisodeId[];
}

export type AssertFactError =
  | AccessDenied
  | FactError
  | { readonly kind: "BankNotFound" }
  | { readonly kind: "BankNotWritable" }
  | { readonly kind: "EpisodeNotFound"; readonly episodeId: EpisodeId }
  | { readonly kind: "DuplicateFact"; readonly factId: FactId };

/**
 * Client-authored fact: the caller is the writer, there is no extractor. Provenance must point
 * at episodes that exist in this bank, so even a manual fact is traceable. It is born
 * `asserted`; only an explicit confirm (by the Subject or a trusted principal) makes it
 * `confirmed`. Machine extraction goes through the Extraction context and the WritePolicy.
 */
export class AssertFactHandler {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessPolicy,
    private readonly clock: Clock,
  ) {}

  async handle(scope: Scope, input: AssertFactInput): Promise<Result<Fact, AssertFactError>> {
    const allowed = this.access.canWrite(scope, input.bankId);
    if (!allowed.ok) return allowed;

    return this.uow.run(async (tx) => {
      const bank = await tx.banks.get(input.bankId, { lock: "share" });
      if (!bank) return err({ kind: "BankNotFound" } as const);
      if (bank.tenantId !== scope.tenantId) return err({ kind: "AccessDenied", bankId: input.bankId, required: "write" } as const);
      if (!canAcceptWrites(bank)) return err({ kind: "BankNotWritable" } as const);

      const unique = [...new Set(input.sourceEpisodeIds)];
      const found = await tx.episodes.getMany(scope, unique);
      const missing = unique.find((id) => !found.some((e) => e.id === id));
      if (missing !== undefined) return err({ kind: "EpisodeNotFound", episodeId: missing } as const);

      const now = this.clock.now();
      const built = assertFact(
        {
          id: input.id,
          bankId: input.bankId,
          statement: input.statement,
          validity: { validFrom: input.validFrom ?? now },
          provenance: { sourceEpisodeIds: unique, writerPrincipalId: scope.principalId, confirmation: "asserted" },
          ...(input.predicate !== undefined ? { predicate: input.predicate } : {}),
        },
        now,
      );
      if (!built.ok) return built;

      try {
        await tx.facts.insert(built.value);
      } catch (e) {
        if (e instanceof DuplicateFactError) return err({ kind: "DuplicateFact", factId: e.factId } as const);
        throw e;
      }
      const event: FactAsserted = {
        type: "memory.FactAsserted",
        occurredAt: now,
        tenantId: scope.tenantId,
        bankId: input.bankId,
        payload: { factId: built.value.id, sourceEpisodeIds: unique },
      };
      await tx.outbox.publish([event]);
      await tx.audit.append({ tenantId: scope.tenantId, bankId: input.bankId, principalId: scope.principalId, action: "fact.asserted", details: { factId: built.value.id }, at: now });
      return ok(built.value);
    });
  }
}
