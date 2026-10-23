import type { Clock, EpisodeId, Result, Scope } from "../../shared-kernel/index.js";
import { err, ok } from "../../shared-kernel/index.js";
import type { AccessDenied, AccessPolicy } from "../../governance/index.js";
import { canAcceptWrites } from "../domain/bank.js";
import { createEpisode, type NewEpisode } from "../domain/episode.js";
import type { EpisodeRecorded } from "../domain/events.js";
import { DuplicateEpisodeError, type UnitOfWork } from "../ports/repositories.js";

export type RecordEpisodeError =
  | AccessDenied
  | { readonly kind: "BankNotFound" }
  | { readonly kind: "BankNotWritable" }
  | { readonly kind: "DuplicateEpisode"; readonly episodeId: EpisodeId };

/**
 * Retain, step 1: record an Episode, its outbox event and its audit entry in one transaction.
 * Extraction and indexing happen asynchronously off the outbox; never on the request path.
 */
export class RecordEpisodeHandler {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessPolicy,
    private readonly clock: Clock,
  ) {}

  async handle(scope: Scope, input: NewEpisode): Promise<Result<{ episodeId: EpisodeId }, RecordEpisodeError>> {
    const allowed = this.access.canWrite(scope, input.bankId);
    if (!allowed.ok) return allowed;

    return this.uow.run(async (tx) => {
      const bank = await tx.banks.get(input.bankId, { lock: "share" });
      if (!bank) return err({ kind: "BankNotFound" } as const);
      if (bank.tenantId !== scope.tenantId) return err({ kind: "AccessDenied", bankId: input.bankId, required: "write" } as const);
      if (!canAcceptWrites(bank)) return err({ kind: "BankNotWritable" } as const);

      const now = this.clock.now();
      const episode = createEpisode(input, scope.principalId, now);
      try {
        await tx.episodes.append(episode);
      } catch (e) {
        if (e instanceof DuplicateEpisodeError) return err({ kind: "DuplicateEpisode", episodeId: e.episodeId } as const);
        throw e;
      }

      const event: EpisodeRecorded = {
        type: "memory.EpisodeRecorded",
        occurredAt: now,
        tenantId: scope.tenantId,
        bankId: episode.bankId,
        payload: { episodeId: episode.id, source: episode.source },
      };
      await tx.outbox.publish([event]);
      await tx.audit.append({ tenantId: scope.tenantId, bankId: episode.bankId, principalId: scope.principalId, action: "episode.recorded", details: { episodeId: episode.id }, at: now });
      return ok({ episodeId: episode.id });
    });
  }
}
