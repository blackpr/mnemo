import type { BankId, Clock, DomainEvent, EpisodeId, ModelRef, Scope, TenantId } from "../../shared-kernel/index.js";
import { asPrincipalId } from "../../shared-kernel/index.js";
import { isSubjectAuthored, type BankRepository, type EpisodeRepository, type FactRepository, type WriteExtractedFactsHandler } from "../../memory/index.js";
import type { Extractor } from "../ports/extractor.js";
import { LlmCallError } from "../ports/llm-client.js";
import type { ClaimedRun, ExtractionRunStore } from "../ports/run-store.js";

export interface RetainPipelineDeps {
  readonly banks: BankRepository;
  readonly episodes: EpisodeRepository;
  readonly facts: FactRepository;
  readonly runs: ExtractionRunStore;
  /** Resolves the Extractor for a bank's configured model. Throws if the model is not available. */
  readonly extractorFor: (model: ModelRef) => Extractor;
  readonly write: WriteExtractedFactsHandler;
  readonly clock: Clock;
  /** How many preceding episodes to include as context. */
  readonly contextTurns?: number;
  /** A running claim older than this is considered abandoned and may be retaken. Must exceed the model call timeout. */
  readonly staleClaimMs?: number;
  readonly maxAttempts?: number;
  /** Delay before retrying after the n-th failure. Default: 30s doubling, capped at 1h. */
  readonly backoffMs?: (attempts: number) => number;
}

export const defaultExtractionBackoffMs = (attempts: number): number => Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempts - 1));

export type ProcessOutcome = "idle" | "done" | "skipped" | "failed";

/**
 * Retain, step 2. Two halves, deliberately decoupled:
 *
 *  - `handle(events)` is the outbox consumer. It only enqueues EpisodeRecorded episodes into the
 *    extraction queue (cheap, idempotent), so indexing never waits on a model call.
 *  - `processNext()` / `drain()` is the worker. It claims one due episode, gathers context
 *    (recent episodes, facts current NOW), extracts, applies through Memory's WriteExtractedFacts
 *    command (idempotent per trigger episode), and records the run with its cost. Failures are
 *    recorded with a backoff; non-retryable model errors dead-letter the episode.
 *
 * Runs with an internal admin Scope for the bank: a trusted background process. Facts it writes
 * carry writerPrincipalId "system:extractor" and the extractor ModelRef.
 */
export class RetainPipeline {
  static readonly principal = asPrincipalId("system:extractor");

  constructor(private readonly deps: RetainPipelineDeps) {}

  /** Outbox consumer: enqueue only. */
  async handle(events: readonly DomainEvent[]): Promise<void> {
    for (const e of events) {
      if (e.type !== "memory.EpisodeRecorded") continue;
      const { episodeId } = e.payload as { episodeId: EpisodeId };
      await this.deps.runs.enqueue(episodeId, e.bankId, e.tenantId, this.deps.clock.now());
    }
  }

  /** Worker: process due episodes until none is due or `max` is reached. Returns how many were processed (not idle). */
  async drain(max = 50): Promise<number> {
    await this.deps.runs.sweepStale(this.deps.clock.now(), this.claimOpts());
    let n = 0;
    while (n < max) {
      const outcome = await this.processNext();
      if (outcome === "idle") break;
      n++;
    }
    return n;
  }

  async processNext(): Promise<ProcessOutcome> {
    const d = this.deps;
    const claim = await d.runs.claimNext(d.clock.now(), this.claimOpts());
    if (!claim) return "idle";
    return this.process(claim);
  }

  private claimOpts() {
    return { staleAfterMs: this.deps.staleClaimMs ?? 10 * 60_000, maxAttempts: this.deps.maxAttempts ?? 8 };
  }

  private async process(claim: ClaimedRun): Promise<ProcessOutcome> {
    const d = this.deps;
    const { episodeId, bankId, tenantId } = claim;
    const scope = internalScope(tenantId, bankId);
    let extractor: Extractor | undefined;
    try {
      const bank = await d.banks.get(bankId);
      if (!bank || bank.tenantId !== tenantId) return this.skip(claim, "bank_not_found");
      if (!bank.policy.extractor) return this.skip(claim, "no_extractor_configured");

      const trigger = await d.episodes.get(scope, episodeId);
      if (!trigger) return this.skip(claim, "episode_not_found");
      if (!isSubjectAuthored(trigger)) return this.skip(claim, "not_subject_authored");

      extractor = d.extractorFor(bank.policy.extractor);
      const recent = (await d.episodes.listRecent(scope, (d.contextTurns ?? 12) + 1, trigger.occurredAt)).filter((e) => e.id !== trigger.id);
      const existing = await d.facts.listCurrent(scope);

      const { candidates, usage } = await extractor.extract(scope, { trigger, recent, existing });

      const written = await d.write.handle(scope, { bankId, extractor: extractor.model, triggerEpisodeId: episodeId, defaultValidFrom: trigger.occurredAt, candidates });
      if (!written.ok) throw new Error(`WriteExtractedFacts failed: ${written.error.kind}`);

      await d.runs.complete(
        claim,
        extractor.model,
        {
          usage,
          candidates: candidates.length,
          asserted: written.value.asserted.length,
          superseded: written.value.superseded.length,
          invalidated: written.value.invalidated.length,
          historical: written.value.historical.length,
          rejected: written.value.rejected.length,
        },
        d.clock.now(),
      );
      return "done";
    } catch (e) {
      const now = d.clock.now();
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      const retryable = e instanceof LlmCallError ? e.retryable : true;
      const usage = e instanceof LlmCallError ? e.usage : undefined;
      const exhausted = claim.attempts >= (d.maxAttempts ?? 8);
      const retryAt = retryable && !exhausted ? new Date(now.getTime() + (d.backoffMs ?? defaultExtractionBackoffMs)(claim.attempts)) : undefined;
      await d.runs.fail(claim, message, now, retryAt, usage);
      return "failed";
    }
  }

  private async skip(claim: ClaimedRun, reason: string): Promise<"skipped"> {
    await this.deps.runs.skip(claim, reason, this.deps.clock.now());
    return "skipped";
  }
}

function internalScope(tenantId: TenantId, bankId: BankId): Scope {
  return { tenantId, bankId, principalId: RetainPipeline.principal, capabilities: new Set(["admin"]) };
}
