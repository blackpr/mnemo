import type { Clock, Result, Scope } from "../../shared-kernel/index.js";
import { err, ok } from "../../shared-kernel/index.js";
import { type AccessPolicy, type AccessDenied } from "../../governance/index.js";
import { canAcceptWrites } from "../domain/bank.js";
import { createEpisode, type NewEpisode } from "../domain/episode.js";
import type { EpisodeRecorded } from "../domain/events.js";
import type { UnitOfWork } from "../ports/repositories.js";

export type RecordEpisodeError = AccessDenied | { readonly kind: "BankNotFound" } | { readonly kind: "BankNotWritable" };

/**
 * Retain, step 1: record an Episode and publish EpisodeRecorded in one transaction.
 * Extraction happens asynchronously off the outbox; never on the request path.
 */
export class RecordEpisodeHandler {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessPolicy,
    private readonly clock: Clock,
  ) {}

  async handle(scope: Scope, input: NewEpisode): Promise<Result<{ episodeId: NewEpisode["id"] }, RecordEpisodeError>> {
    const allowed = this.access.canWrite(scope, input.bankId);
    if (!allowed.ok) return allowed;

    return this.uow.run(async (tx) => {
      const bank = await tx.banks.get(input.bankId);
      if (!bank) return err({ kind: "BankNotFound" } as const);
      if (!canAcceptWrites(bank)) return err({ kind: "BankNotWritable" } as const);

      const now = this.clock.now();
      const episode = createEpisode(input, scope.principalId, now);
      await tx.episodes.append(episode);

      const event: EpisodeRecorded = {
        type: "memory.EpisodeRecorded",
        occurredAt: now,
        tenantId: scope.tenantId,
        bankId: episode.bankId,
        payload: { episodeId: episode.id, source: episode.source },
      };
      await tx.outbox.publish([event]);
      return ok({ episodeId: episode.id });
    });
  }
}
