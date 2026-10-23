import type { ModelRef } from "../shared-kernel/index.js";

/**
 * Provider spec parsing shared by every adapter that talks to a model provider
 * (extraction LLMs, retrieval embedders). Infrastructure utility, not a bounded context.
 */
export const SUPPORTED_PROVIDERS = ["anthropic", "google", "openai", "openai-compatible"] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export function isSupportedProvider(p: string): p is SupportedProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(p);
}

/** Parses "provider:model" (e.g. "anthropic:claude-opus-5-5") into a ModelRef with the given version tag. */
export function parseModelSpec(spec: string, version = "v1"): ModelRef {
  const idx = spec.indexOf(":");
  if (idx <= 0 || idx === spec.length - 1) throw new Error(`Model spec must be "provider:model", got "${spec}"`);
  const provider = spec.slice(0, idx);
  if (!isSupportedProvider(provider)) throw new Error(`Unsupported provider "${provider}" (supported: ${SUPPORTED_PROVIDERS.join(", ")})`);
  return { provider, model: spec.slice(idx + 1), version };
}

export function openAiCompatibleBaseUrl(env: NodeJS.ProcessEnv): string {
  const baseURL = env.OPENAI_COMPATIBLE_BASE_URL;
  if (!baseURL) throw new Error("OPENAI_COMPATIBLE_BASE_URL is required for provider openai-compatible (e.g. http://localhost:11434/v1 for Ollama)");
  return baseURL;
}
