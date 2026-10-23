import { randomUUID } from "node:crypto";
import { asEpisodeId, asFactId, type ModelRef, type Scope } from "../../shared-kernel/index.js";
import type { ExtractedCandidate } from "../../memory/index.js";
import { extractionOutputSchema } from "../domain/extraction-output.js";
import { buildExtractionUserPrompt, EXTRACTION_SYSTEM_PROMPT, PROMPT_VERSION } from "../domain/prompt.js";
import type { ExtractionContext, Extractor } from "../ports/extractor.js";
import type { LlmClient } from "../ports/llm-client.js";

export interface LlmExtractorOptions {
  /** Upper bound on existing facts shown to the model (most recent by validFrom). Bounds the per-episode write cost. */
  readonly maxExistingFacts?: number;
  readonly maxEpisodeChars?: number;
  readonly maxOutputTokens?: number;
  readonly newId?: () => string;
}

/**
 * LLM-backed Extractor. Builds the prompt, asks the model for structured output, and
 * sanitizes the result: unknown episode or fact ids are dropped (the model may hallucinate
 * ids), invalid dates become undefined, a candidate whose cited sources were all unknown is
 * attributed to the trigger with halved faithfulness (the model did not actually claim that
 * provenance). The returned candidates are still only candidates; Memory's WritePolicy decides.
 */
export class LlmExtractor implements Extractor {
  readonly model: ModelRef;
  private readonly maxExistingFacts: number;
  private readonly maxEpisodeChars: number;
  private readonly maxOutputTokens: number;
  private readonly newId: () => string;

  constructor(
    private readonly llm: LlmClient,
    opts: LlmExtractorOptions = {},
  ) {
    this.model = { ...llm.model, version: `${llm.model.version}+${PROMPT_VERSION}` };
    this.maxExistingFacts = opts.maxExistingFacts ?? 200;
    this.maxEpisodeChars = opts.maxEpisodeChars ?? 8_000;
    this.maxOutputTokens = opts.maxOutputTokens ?? 4_000;
    this.newId = opts.newId ?? randomUUID;
  }

  async extract(_scope: Scope, ctx: ExtractionContext) {
    const existing = ctx.existing.slice(-this.maxExistingFacts);
    const episodeIds = new Set<string>([ctx.trigger.id, ...ctx.recent.map((e) => e.id)]);
    const factIds = new Set<string>(existing.map((f) => f.id));

    const r = await this.llm.completeStructured({
      system: EXTRACTION_SYSTEM_PROMPT,
      user: buildExtractionUserPrompt({ trigger: ctx.trigger, recent: ctx.recent, existing, maxEpisodeChars: this.maxEpisodeChars }),
      schema: extractionOutputSchema,
      schemaName: "extraction",
      maxOutputTokens: this.maxOutputTokens,
    });

    const candidates: ExtractedCandidate[] = [];
    for (const c of r.value.candidates) {
      const cited = c.sourceEpisodeIds.filter((id) => episodeIds.has(id));
      const sources = cited.length > 0 ? cited : [ctx.trigger.id];
      const faithfulness = Math.min(1, Math.max(0, c.faithfulness)) * (cited.length > 0 ? 1 : 0.5);
      const validFrom = c.validFrom ? new Date(c.validFrom) : undefined;
      candidates.push({
        id: asFactId(this.newId()),
        statement: c.statement.trim(),
        sourceEpisodeIds: sources.map(asEpisodeId),
        faithfulness,
        related: c.related.filter((rel) => factIds.has(rel.factId)).map((rel) => ({ factId: asFactId(rel.factId), relation: rel.relation })),
        ...(c.predicate ? { predicate: c.predicate } : {}),
        ...(validFrom && !Number.isNaN(validFrom.getTime()) ? { validFrom } : {}),
      });
    }
    return { candidates, usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, latencyMs: r.latencyMs } };
  }
}
