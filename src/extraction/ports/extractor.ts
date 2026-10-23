import type { ModelRef, Scope } from "../../shared-kernel/index.js";
import type { Episode, Fact, NewFact } from "../../memory/index.js";

/**
 * Extractor: turns Episodes into candidate Facts. A strategy, replaceable per Bank.
 * Implementations are LLM-backed (one per provider via LlmClient) or NoopExtractor.
 * Must report which model and prompt version produced each candidate (Provenance.extractor).
 */
export interface CandidateFact {
  readonly fact: Omit<NewFact, "id" | "bankId">;
  /** Existing facts the extractor believes this candidate relates to, with its judgement. */
  readonly related: readonly { readonly factId: Fact["id"]; readonly contradicts: boolean; readonly candidateIsNewer: boolean }[];
  readonly faithfulness: number;
}

export interface ExtractionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

export interface Extractor {
  readonly model: ModelRef;
  extract(scope: Scope, episodes: readonly Episode[], existing: readonly Fact[]): Promise<{ readonly candidates: readonly CandidateFact[]; readonly usage: ExtractionUsage }>;
}

export const noopExtractor = (model: ModelRef): Extractor => ({
  model,
  extract: async () => ({ candidates: [], usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 } }),
});
