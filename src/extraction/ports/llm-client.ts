import type { ZodType } from "zod";
import type { ModelRef } from "../../shared-kernel/index.js";
import type { ExtractionUsage } from "./extractor.js";

/**
 * LlmClient: anti-corruption layer in front of model providers. Extraction depends on this
 * port only; the adapter (Vercel AI SDK with provider packages) lives in infrastructure.
 * Structured output is required by every extractor, so it is the port's one operation.
 */
export interface StructuredCompletion<T> {
  readonly value: T;
  /** Nominal prompt tokens (cache reads and writes included). */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  /** Prompt tokens the provider served from its prompt cache, when it reports them. */
  readonly cachedInputTokens?: number;
  /** Prompt tokens the provider wrote to its prompt cache on this call, when it reports them. */
  readonly cacheWriteTokens?: number;
}

export interface LlmClient {
  readonly model: ModelRef;
  completeStructured<T>(input: {
    /** Stable across calls: the adapter may mark it for provider prompt caching. */
    readonly system: string;
    readonly user: string;
    readonly schema: ZodType<T>;
    readonly schemaName?: string;
    readonly maxOutputTokens?: number;
  }): Promise<StructuredCompletion<T>>;
}

/**
 * The one error adapters throw. `retryable` false means repeating the identical call cannot
 * succeed (output truncated, schema never satisfied, bad request); the caller should not retry.
 * `usage` carries what the failed call cost when the provider reported it.
 */
export class LlmCallError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly usage?: ExtractionUsage,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LlmCallError";
  }
}
