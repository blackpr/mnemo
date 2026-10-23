import type { ModelRef } from "../../shared-kernel/index.js";

/**
 * LlmClient: anti-corruption layer in front of provider SDKs (Anthropic, Google, OpenAI, Ollama).
 * Extraction depends on this port only; provider SDKs live in infrastructure.
 * Structured output is required (every extractor relies on it), so it is part of the port.
 */
export interface LlmClient {
  readonly model: ModelRef;
  completeStructured<T>(input: {
    readonly system: string;
    readonly user: string;
    readonly schema: object; // JSON Schema for T
    readonly maxOutputTokens?: number;
  }): Promise<{ readonly value: T; readonly inputTokens: number; readonly outputTokens: number; readonly latencyMs: number }>;
}
