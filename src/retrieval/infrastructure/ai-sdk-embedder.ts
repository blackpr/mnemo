import { embedMany, type EmbeddingModel } from "ai";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { isSupportedProvider, openAiCompatibleBaseUrl, parseModelSpec, SUPPORTED_PROVIDERS } from "../../platform/providers.js";
import type { Embedder } from "../ports/embedder.js";
import { HashingEmbedder } from "./hashing-embedder.js";

/**
 * Production Embedder over the Vercel AI SDK. Same adapter for OpenAI, Google and
 * OpenAI-compatible endpoints (Anthropic has no embeddings API). The embedder id includes the
 * provider, model and dimensions, and the engine stores it on every row: vectors from different
 * embedders are never compared, and a switch is a reindex, not a migration.
 */
export interface AiSdkEmbedderOptions {
  /** Request a reduced dimensionality where the model supports it (OpenAI text-embedding-3-*, Gemini embeddings). */
  readonly dimensions?: number;
  readonly timeoutMs?: number;
  /** Inject a model (e.g. a mock) instead of resolving one. */
  readonly embeddingModel?: EmbeddingModel;
}

const KEY_FOR_PROVIDER: Record<Exclude<ReturnType<typeof providerOf>, undefined>, string> = {
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  "openai-compatible": "OPENAI_COMPATIBLE_BASE_URL",
  anthropic: "ANTHROPIC_API_KEY",
};
function providerOf(p: string) {
  return isSupportedProvider(p) ? p : undefined;
}

/**
 * Providers load their key lazily at request time, which would let a misconfigured server boot
 * and then fail on every projection and recall. Check up front instead.
 */
export function assertProviderCredentials(provider: string, env: NodeJS.ProcessEnv = process.env): void {
  const p = providerOf(provider);
  if (!p) return;
  const name = KEY_FOR_PROVIDER[p];
  if (!env[name]) throw new Error(`${name} is not set but EMBEDDER uses provider "${provider}"`);
}

export function resolveEmbeddingModel(provider: string, model: string, env: NodeJS.ProcessEnv = process.env): EmbeddingModel {
  if (!isSupportedProvider(provider)) throw new Error(`Unsupported provider "${provider}" (supported: ${SUPPORTED_PROVIDERS.join(", ")})`);
  assertProviderCredentials(provider, env);
  switch (provider) {
    case "openai":
      return createOpenAI().textEmbedding(model);
    case "google":
      return createGoogle().textEmbedding(model);
    case "openai-compatible":
      return createOpenAI({ baseURL: openAiCompatibleBaseUrl(env), apiKey: env.OPENAI_COMPATIBLE_API_KEY ?? "none" }).textEmbedding(model);
    case "anthropic":
      throw new Error("Anthropic does not offer an embeddings API; use google or openai for EMBEDDER");
  }
}

export class AiSdkEmbedder implements Embedder {
  readonly id: string;
  /** Requested dimensions, or the dimensionality observed on the first successful call. */
  dimensions: number | undefined;
  private readonly model: EmbeddingModel;
  private readonly timeoutMs: number;
  private readonly requestedDimensions: number | undefined;

  constructor(
    readonly provider: string,
    readonly modelId: string,
    opts: AiSdkEmbedderOptions = {},
  ) {
    this.model = opts.embeddingModel ?? resolveEmbeddingModel(provider, modelId);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.requestedDimensions = opts.dimensions;
    // The id must be stable before the first call, so it carries the requested value or "native".
    // Set EMBEDDING_DIMENSIONS to pin the dimensionality explicitly (recommended for production).
    this.dimensions = opts.dimensions;
    this.id = `${provider}/${modelId}@${opts.dimensions ?? "native"}`;
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return [];
    const r = await embedMany({
      model: this.model,
      values: [...texts],
      ...(this.requestedDimensions !== undefined ? { dimensions: this.requestedDimensions } : {}),
      abortSignal: AbortSignal.timeout(this.timeoutMs),
    });
    if (r.embeddings.length !== texts.length) throw new Error(`embedder returned ${r.embeddings.length} vectors for ${texts.length} inputs`);
    const dims = r.embeddings[0]?.length ?? 0;
    if (this.requestedDimensions !== undefined && dims !== this.requestedDimensions) {
      throw new Error(`embedder ${this.id} returned ${dims} dimensions, expected ${this.requestedDimensions}`);
    }
    // Native dimensionality must not drift within a process: mixed vectors under one id would break recall.
    if (this.dimensions === undefined) this.dimensions = dims;
    else if (dims !== this.dimensions) throw new Error(`embedder ${this.id} returned ${dims} dimensions, previously ${this.dimensions}`);
    return r.embeddings;
  }
}

/** The width the pgvector index is pinned to when EMBEDDING_DIMENSIONS is unset: openai:text-embedding-3-small's native size. */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

/**
 * The dimensionality every embedder must produce and the index column is pinned to
 * (`admin pin-dimensions`). EMBEDDING_DIMENSIONS, default 1536. When set explicitly it is also
 * requested from providers that support reduction and becomes part of the embedder id.
 */
export function embeddingDimensionsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.EMBEDDING_DIMENSIONS, "EMBEDDING_DIMENSIONS") ?? DEFAULT_EMBEDDING_DIMENSIONS;
}

/**
 * Builds the configured Embedder. `spec` is "provider:model" or "hashing" (the offline test
 * double). `EMBEDDING_DIMENSIONS` is optional for providers (unset means the model's native width,
 * expected to be DEFAULT_EMBEDDING_DIMENSIONS; the boot probe checks); the hashing embedder always
 * produces the configured width so it boots against a pinned index without extra configuration.
 */
export function embedderFromEnv(env: NodeJS.ProcessEnv = process.env): Embedder {
  const spec = env.EMBEDDER ?? "openai:text-embedding-3-small";
  const dims = positiveInt(env.EMBEDDING_DIMENSIONS, "EMBEDDING_DIMENSIONS");
  const timeoutMs = positiveInt(env.EMBEDDER_TIMEOUT_MS, "EMBEDDER_TIMEOUT_MS");
  if (spec === "hashing") return new HashingEmbedder(dims ?? DEFAULT_EMBEDDING_DIMENSIONS);
  const ref = parseModelSpec(spec);
  return new AiSdkEmbedder(ref.provider, ref.model, {
    embeddingModel: resolveEmbeddingModel(ref.provider, ref.model, env),
    ...(dims !== undefined ? { dimensions: dims } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

function positiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${value}"`);
  return n;
}
