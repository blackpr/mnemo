/**
 * The one model binding for the eval: answering model, question drafter and spend arithmetic all
 * come from here so every arm (and every result row) records the same model ref. Same library as
 * `src/extraction/infrastructure/ai-sdk-llm-client.ts` (Vercel AI SDK + provider package); the
 * credential is ANTHROPIC_API_KEY from `.env`, never passed around.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

/** Frozen for the spike: same answering model in every arm, and the grader is pinned to the same ref in the promptfoo config. */
export const ANSWERING_MODEL = "anthropic:claude-opus-5-5" as const;
export const GRADER_MODEL = "anthropic:claude-opus-5-5" as const;

/** Anthropic list price (USD per million tokens) for claude-opus-5-5, checked 2026-10-23 (cache read and 5-minute cache write 2026-10-24). */
export const PRICE_USD_PER_MTOK = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } as const;

/** `inputTokens` is nominal (cache reads and writes included); the cached subsets, when known, are repriced. */
export function costUsd(usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number }): number {
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  const plain = usage.inputTokens - cached - written;
  // The nominal count includes cache reads and writes (@ai-sdk/anthropic 4.x); a negative remainder means a source with other semantics.
  if (plain < 0) throw new Error(`costUsd: cached (${cached}) + cache-write (${written}) tokens exceed the nominal input (${usage.inputTokens}); the source does not count cache tokens in its input`);
  return (plain * PRICE_USD_PER_MTOK.input + cached * PRICE_USD_PER_MTOK.cacheRead + written * PRICE_USD_PER_MTOK.cacheWrite + usage.outputTokens * PRICE_USD_PER_MTOK.output) / 1_000_000;
}

export function languageModel(spec: string = ANSWERING_MODEL): LanguageModel {
  const idx = spec.indexOf(":");
  const provider = spec.slice(0, idx);
  const model = spec.slice(idx + 1);
  if (provider !== "anthropic" || model === "") throw new Error(`eval models are pinned to anthropic:<model>; got ${JSON.stringify(spec)}`);
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (load .env: the npm eval:* scripts do)");
  return createAnthropic()(model);
}

/** Hard wall-clock limit per model call, including the SDK's own retries. */
export const LLM_TIMEOUT_MS = Number(process.env.EVAL_LLM_TIMEOUT_MS ?? 180_000);
