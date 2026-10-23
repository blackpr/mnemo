import type { BankId, DomainEvent, EpisodeId, FactId, Scope, TenantId } from "../../shared-kernel/index.js";
import { asPrincipalId } from "../../shared-kernel/index.js";
import type { EpisodeRepository, FactRepository } from "../../memory/index.js";
import type { RetrievalEngine } from "../ports/retrieval-engine.js";

/**
 * Keeps the engine's derived state in step with the system of record by consuming Memory's
 * outbox events. Idempotent: indexing is an upsert and retraction is a flag, so redelivery is safe.
 *
 * It reads with an internal, admin-capability Scope for the event's bank. This is a trusted
 * background process, not a caller; the Scope exists so repository reads stay bank-filtered.
 */
export class IndexingProjector {
  static readonly principal = asPrincipalId("system:indexing-projector");

  constructor(
    private readonly engine: RetrievalEngine,
    private readonly facts: FactRepository,
    private readonly episodes: EpisodeRepository,
  ) {}

  async handle(events: readonly DomainEvent[]): Promise<void> {
    for (const e of events) await this.handleOne(e);
  }

  private async handleOne(e: DomainEvent): Promise<void> {
    const scope = internalScope(e.tenantId, e.bankId);
    switch (e.type) {
      case "memory.EpisodeRecorded": {
        const { episodeId } = e.payload as { episodeId: EpisodeId };
        const episode = await this.episodes.get(scope, episodeId);
        if (episode) await this.engine.indexEpisode(episode);
        return;
      }
      case "memory.FactAsserted": {
        const { factId } = e.payload as { factId: FactId };
        const fact = await this.facts.get(scope, factId);
        if (fact) await this.engine.indexFact(fact);
        return;
      }
      case "memory.FactSuperseded": {
        const { oldFactId, newFactId } = e.payload as { oldFactId: FactId; newFactId: FactId };
        await this.engine.retractFact(oldFactId);
        const fact = await this.facts.get(scope, newFactId);
        if (fact) await this.engine.indexFact(fact);
        return;
      }
      case "memory.FactInvalidated": {
        const { factId } = e.payload as { factId: FactId };
        await this.engine.retractFact(factId);
        return;
      }
      default:
        return; // confirmations and other events do not change the index
    }
  }
}

function internalScope(tenantId: TenantId, bankId: BankId): Scope {
  return { tenantId, bankId, principalId: IndexingProjector.principal, capabilities: new Set(["admin"]) };
}
