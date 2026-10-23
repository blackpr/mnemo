import type { ModelRef, Scope } from "../../shared-kernel/index.js";
import type { Episode, ExtractedCandidate, Fact } from "../../memory/index.js";

/**
 * Extractor: turns Episodes into candidate Facts. A strategy, replaceable per Bank.
 * Implementations are LLM-backed (via LlmClient) or NoopExtractor.
 * Reports which model and prompt version produced the candidates (Provenance.extractor).
 */
export interface ExtractionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

export interface ExtractionContext {
  /** The episode that triggered extraction. */
  readonly trigger: Episode;
  /** Recent episodes before the trigger, oldest first, for context. */
  readonly recent: readonly Episode[];
  /** Facts currently believed about the Subject, so the extractor can relate candidates to them. */
  readonly existing: readonly Fact[];
}

export interface Extractor {
  readonly model: ModelRef;
  extract(scope: Scope, ctx: ExtractionContext): Promise<{ readonly candidates: readonly ExtractedCandidate[]; readonly usage: ExtractionUsage }>;
}

export const noopExtractor = (model: ModelRef): Extractor => ({
  model,
  extract: async () => ({ candidates: [], usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 } }),
});
