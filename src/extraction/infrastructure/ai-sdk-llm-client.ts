import { APICallError, generateText, NoObjectGeneratedError, Output, type LanguageModel, type SystemModelMessage } from "ai";
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
 * GOOGLE_GENERATIVE_AI_API_KEY, OPENAI_API_KEY). The only provider-specific option set is
 * Anthropic prompt caching on the system prompt (`providerOptions.anthropic.cacheControl` on the
 * instructions message, `@ai-sdk/anthropic` 4.x): the instructions are the stable prefix of every
 * extraction call, so after the first call they are read from the provider's cache at a fraction
 * of the price. The prefix must clear the model's minimum cacheable length (512 tokens on Opus 5.5,
 * more on older models) or the provider silently caches nothing; the extraction system prompt is
 * about 1,020 tokens (measured live 2026-10-24: 1,017 written, then 1,017 read). Other providers
 * ignore the option. Reasoning is not requested (provider default).
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
  /** Mark the system prompt for Anthropic prompt caching (default: on for the anthropic provider). */
  readonly cacheSystemPrompt?: boolean;
}

/** Finishes that will repeat identically on the same input: not worth a retry. */
const NON_RETRYABLE_FINISH = new Set(["length", "content-filter"]);

export class AiSdkLlmClient implements LlmClient {
  private readonly lm: LanguageModel;
  private readonly timeoutMs: number;
  private readonly cacheSystemPrompt: boolean;

  constructor(
    readonly model: ModelRef,
    opts: AiSdkLlmClientOptions = {},
  ) {
    this.lm = opts.languageModel ?? resolveLanguageModel(model);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.cacheSystemPrompt = opts.cacheSystemPrompt ?? model.provider === "anthropic";
  }

  async completeStructured<T>(input: {
    readonly system: string;
    readonly user: string;
    readonly schema: ZodType<T>;
    readonly schemaName?: string;
    readonly maxOutputTokens?: number;
  }): Promise<StructuredCompletion<T>> {
    const started = Date.now();
    const instructions: SystemModelMessage = {
      role: "system",
      content: input.system,
      ...(this.cacheSystemPrompt ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } } : {}),
    };
    try {
      const result = await generateText({
        model: this.lm,
        instructions,
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
      return { value, ...usage };
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

interface SdkUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?: { cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined } | undefined;
}

/** `inputTokens` is the SDK's total (cache reads and writes included); the details split it. Absent details stay absent (the ledger keeps NULL, not 0). */
function usageOf(u: SdkUsage | undefined, started: number) {
  const d = u?.inputTokenDetails;
  return {
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    latencyMs: Date.now() - started,
    ...(d?.cacheReadTokens !== undefined ? { cachedInputTokens: d.cacheReadTokens } : {}),
    ...(d?.cacheWriteTokens !== undefined ? { cacheWriteTokens: d.cacheWriteTokens } : {}),
  };
}
