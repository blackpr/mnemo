import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MockLanguageModelV3 } from "ai/test";
import { AiSdkLlmClient, LlmCallError, parseModelSpec, resolveLanguageModel } from "../../src/extraction/index.js";

const ref = { provider: "anthropic", model: "mock", version: "t" } as const;
const schema = z.object({ city: z.string() });

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});
const generate = (text: string, unified: "stop" | "length" | "content-filter" | "error" = "stop", input = 10, output = 5) =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      content: text.length > 0 ? [{ type: "text" as const, text }] : [],
      finishReason: { unified, raw: unified },
      usage: usage(input, output),
      warnings: [],
    }),
  });
const client = (lm: MockLanguageModelV3) => new AiSdkLlmClient(ref, { languageModel: lm, timeoutMs: 5_000 });
const call = (lm: MockLanguageModelV3) => client(lm).completeStructured({ system: "s", user: "u", schema });
const failure = async (p: Promise<unknown>): Promise<LlmCallError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof LlmCallError) return e;
    throw e;
  }
  throw new Error("expected LlmCallError");
};

describe("AiSdkLlmClient", () => {
  it("parses provider:model specs and validates the provider", () => {
    expect(parseModelSpec("anthropic:claude-opus-5-5", "v2")).toEqual({ provider: "anthropic", model: "claude-opus-5-5", version: "v2" });
    expect(() => parseModelSpec("claude-opus-5-5")).toThrow(/provider:model/);
    expect(() => parseModelSpec("anthropic:")).toThrow();
    expect(() => parseModelSpec("antropic:claude-opus-5-5")).toThrow(/Unsupported/);
  });

  it("rejects unknown providers and requires a base URL for openai-compatible", () => {
    expect(() => resolveLanguageModel({ provider: "nope", model: "x", version: "v1" })).toThrow(/Unsupported/);
    expect(() => resolveLanguageModel({ provider: "openai-compatible", model: "llama3", version: "v1" }, {})).toThrow(/OPENAI_COMPATIBLE_BASE_URL/);
  });

  it("returns the validated object and usage on success", async () => {
    const r = await call(generate('{"city":"Lisbon"}', "stop", 42, 7));
    expect(r.value).toEqual({ city: "Lisbon" });
    expect(r.inputTokens).toBe(42);
    expect(r.outputTokens).toBe(7);
  });

  it("schema-invalid complete output is a retryable LlmCallError with usage", async () => {
    const e = await failure(call(generate('{"town":"Lisbon"}', "stop", 11, 3)));
    expect(e.retryable).toBe(true);
    expect(e.usage?.inputTokens).toBe(11);
    expect(e.message).toMatch(/structured output failed/);
  });

  it("truncated output (finishReason length) is non-retryable and keeps usage", async () => {
    const e = await failure(call(generate('{"city":"Lis', "length", 20, 4000)));
    expect(e.retryable).toBe(false);
    expect(e.usage?.outputTokens).toBe(4000);
  });

  it("an empty content-filtered answer is non-retryable with usage; an empty transient error is retryable", async () => {
    const filtered = await failure(call(generate("", "content-filter", 15, 0)));
    expect(filtered.retryable).toBe(false);
    expect(filtered.usage?.inputTokens).toBe(15);
    expect(filtered.message).toMatch(/content-filter/);
    const transient = await failure(call(generate("", "error", 15, 0)));
    expect(transient.retryable).toBe(true);
  });

  it("a thrown provider error is wrapped as retryable", async () => {
    const lm = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("socket hang up");
      },
    });
    const e = await failure(call(lm));
    expect(e.retryable).toBe(true);
    expect(e.message).toContain("socket hang up");
  });

  // Paid call: only with an explicit opt-in (npm run test:live) and a key.
  const hasKey = process.env.RUN_LIVE_TESTS === "1" && Boolean(process.env.ANTHROPIC_API_KEY);
  (hasKey ? it : it.skip)("returns schema-valid structured output from the real provider", async () => {
    const real = new AiSdkLlmClient({ provider: "anthropic", model: "claude-opus-5-5", version: "smoke" }, { timeoutMs: 50_000 });
    const r = await real.completeStructured({
      system: "You extract structured data.",
      user: "The user said: 'I use neovim and I live in Lisbon.' Return the editor and the city.",
      schema: z.object({ editor: z.string(), city: z.string() }),
      maxOutputTokens: 200,
    });
    expect(r.value.editor.toLowerCase()).toContain("neovim");
    expect(r.value.city.toLowerCase()).toContain("lisbon");
    expect(r.inputTokens).toBeGreaterThan(0);
  }, 60_000);
});
