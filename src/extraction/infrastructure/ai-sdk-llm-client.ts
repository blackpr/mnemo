import { APICallError, generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { ZodType } from "zod";
import type { ModelRef } from "../../shared-kernel/index.js";
import { isSupportedProvider, openAiCompatibleBaseUrl, parseModelSpec, SUPPORTED_PROVIDERS, type SupportedProvider } from "../../platform/providers.js";
import { LlmCallError, type LlmClient, type StructuredCompletion } from "../ports/llm-client.js";

export { isSupportedProvider, parseModelSpec, SUPPORTED_PROVIDERS, type SupportedProvider };

/**
 * The one LLM adapter: Vercel AI SDK with provider packages, so the same code path serves
 * Anthropic, Google and OpenAI (and any OpenAI-compatible endpoint such as Ollama). Credentials
 * come from the providers' standard environment variables (ANTHROPIC_API_KEY,
 * GOOGLE_GENERATIVE_AI_API_KEY, OPENAI_API_KEY). No provider-specific options are set: each
 * model runs with its provider defaults (for Anthropic that means reasoning is not requested;
 * it can be enabled through providerOptions when the spike shows it helps).
 */
export function resolveLanguageModel(ref: ModelRef, env: NodeJS.ProcessEnv = process.env): LanguageModel {
  if (!isSupportedProvider(ref.provider)) {
    throw new Error(`Unsupported LLM provider "${ref.provider}" (supported: ${SUPPORTED_PROVIDERS.join(", ")})`);
  }
  switch (ref.provider) {
    case "anthropic":
      return createAnthropic()(ref.model);
    case "google":
      return createGoogle()(ref.model);
    case "openai":
      return createOpenAI()(ref.model);
    case "openai-compatible":
      return createOpenAI({ baseURL: openAiCompatibleBaseUrl(env), apiKey: env.OPENAI_COMPATIBLE_API_KEY ?? "none" }).chat(ref.model);
  }
}

export interface AiSdkLlmClientOptions {
  /** Hard wall-clock limit per call (including the SDK's own retries). A hung provider must never hang the worker. */
  readonly timeoutMs?: number;
  /** Inject a model (e.g. a mock) instead of resolving one from the ModelRef. */
  readonly languageModel?: LanguageModel;
}

/** Finishes that will repeat identically on the same input: not worth a retry. */
const NON_RETRYABLE_FINISH = new Set(["length", "content-filter"]);

export class AiSdkLlmClient implements LlmClient {
  private readonly lm: LanguageModel;
  private readonly timeoutMs: number;

  constructor(
    readonly model: ModelRef,
    opts: AiSdkLlmClientOptions = {},
  ) {
    this.lm = opts.languageModel ?? resolveLanguageModel(model);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async completeStructured<T>(input: {
    readonly system: string;
    readonly user: string;
    readonly schema: ZodType<T>;
    readonly schemaName?: string;
    readonly maxOutputTokens?: number;
  }): Promise<StructuredCompletion<T>> {
    const started = Date.now();
    try {
      const result = await generateText({
        model: this.lm,
        instructions: input.system,
        prompt: input.user,
        output: Output.object({ schema: input.schema, ...(input.schemaName !== undefined ? { name: input.schemaName } : {}) }),
        maxOutputTokens: input.maxOutputTokens ?? 4000,
        abortSignal: AbortSignal.timeout(this.timeoutMs),
      });
      const usage = usageOf(result.usage, started);
      const finish = finishReasonOf(result.finishReason);
      if (finish !== "stop" && result.text.trim().length === 0) {
        throw new LlmCallError(`model produced no output (finishReason: ${finish})`, !NON_RETRYABLE_FINISH.has(finish), usage);
      }
      // `output` is a getter: it parses and validates lazily and throws NoObjectGeneratedError on failure.
      const value = result.output as T;
      return { value, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs: usage.latencyMs };
    } catch (e) {
      if (e instanceof LlmCallError) throw e;
      if (NoObjectGeneratedError.isInstance(e)) {
        const finish = e.finishReason !== undefined ? finishReasonOf(e.finishReason) : "unknown";
        // Truncated output repeats identically; a schema miss on a complete answer may not (models are stochastic).
        throw new LlmCallError(`structured output failed (${finish}): ${e.message}`, !NON_RETRYABLE_FINISH.has(finish), usageOf(e.usage, started), { cause: e });
      }
      if (APICallError.isInstance(e)) {
        throw new LlmCallError(`provider error ${e.statusCode ?? ""}: ${e.message}`.trim(), e.isRetryable, undefined, { cause: e });
      }
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new LlmCallError(`model call timed out after ${this.timeoutMs} ms`, true, undefined, { cause: e });
      }
      throw new LlmCallError(e instanceof Error ? e.message : String(e), true, undefined, { cause: e });
    }
  }
}

/** The SDK's finish reason is a string in some versions and `{ unified, raw }` in others; normalize. */
function finishReasonOf(fr: unknown): string {
  if (typeof fr === "string") return fr;
  if (fr && typeof fr === "object" && "unified" in fr) return String((fr as { unified: unknown }).unified);
  return "unknown";
}

function usageOf(u: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined, started: number) {
  return { inputTokens: u?.inputTokens ?? 0, outputTokens: u?.outputTokens ?? 0, latencyMs: Date.now() - started };
}
