import { describe, expect, it } from "vitest";
import { MockEmbeddingModelV3 } from "ai/test";
import { AiSdkEmbedder, embedderFromEnv, HashingEmbedder, resolveEmbeddingModel } from "../../src/retrieval/index.js";

const mock = (dims: number, perCall = 100) =>
  new MockEmbeddingModelV3({
    maxEmbeddingsPerCall: perCall,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((v, i) => Array.from({ length: dims }, (_, d) => (d === 0 ? v.length : i))),
      usage: { tokens: values.length },
      warnings: [],
    }),
  });

describe("AiSdkEmbedder", () => {
  it("has a stable id carrying provider, model and requested dimensions", () => {
    expect(new AiSdkEmbedder("openai", "text-embedding-3-small", { embeddingModel: mock(8), dimensions: 8 }).id).toBe("openai/text-embedding-3-small@8");
    expect(new AiSdkEmbedder("google", "gemini-embedding-001", { embeddingModel: mock(8) }).id).toBe("google/gemini-embedding-001@native");
  });

  it("embeds in input order, batching across the model's per-call limit", async () => {
    const m = mock(4, 3);
    const e = new AiSdkEmbedder("openai", "m", { embeddingModel: m });
    const texts = ["a", "bb", "ccc", "dddd", "eeeee", "ffffff", "ggggggg"];
    const out = await e.embed(texts);
    expect(out).toHaveLength(7);
    expect(out.map((v) => v[0])).toEqual(texts.map((t) => t.length));
    expect(m.doEmbedCalls.length).toBeGreaterThan(1);
    expect(await e.embed([])).toEqual([]);
  });

  it("fails loudly when the provider returns the wrong dimensionality, or drifts between calls", async () => {
    const e = new AiSdkEmbedder("openai", "m", { embeddingModel: mock(4), dimensions: 8 });
    await expect(e.embed(["x"])).rejects.toThrow(/returned 4 dimensions, expected 8/);

    let dims = 4;
    const drifting = new MockEmbeddingModelV3({ doEmbed: async ({ values }) => ({ embeddings: values.map(() => Array.from({ length: dims }, () => 0.5)), usage: { tokens: 1 }, warnings: [] }) });
    const n = new AiSdkEmbedder("openai", "m", { embeddingModel: drifting });
    expect(n.dimensions).toBeUndefined();
    await n.embed(["a"]);
    expect(n.dimensions).toBe(4);
    dims = 8;
    await expect(n.embed(["b"])).rejects.toThrow(/returned 8 dimensions, previously 4/);
  });

  it("resolution: anthropic has no embeddings; unknown providers rejected; env builder understands hashing and specs", () => {
    expect(() => resolveEmbeddingModel("anthropic", "x")).toThrow(/embeddings API/);
    expect(() => resolveEmbeddingModel("nope", "x")).toThrow(/Unsupported/);
    expect(embedderFromEnv({ EMBEDDER: "hashing", EMBEDDING_DIMENSIONS: "64" })).toBeInstanceOf(HashingEmbedder);
    expect(embedderFromEnv({ EMBEDDER: "hashing", EMBEDDING_DIMENSIONS: "64" }).dimensions).toBe(64);
    expect(() => embedderFromEnv({ EMBEDDER: "nonsense" })).toThrow(/provider:model/);
    const e = embedderFromEnv({ EMBEDDER: "openai:text-embedding-3-small", EMBEDDING_DIMENSIONS: "512", OPENAI_API_KEY: "test" });
    expect(e.id).toBe("openai/text-embedding-3-small@512");
    // Fail fast at boot instead of on the first request.
    expect(() => embedderFromEnv({ EMBEDDER: "openai:text-embedding-3-small" })).toThrow(/OPENAI_API_KEY/);
    expect(() => embedderFromEnv({ EMBEDDER: "google:gemini-embedding-001" })).toThrow(/GOOGLE_GENERATIVE_AI_API_KEY/);
    expect(() => embedderFromEnv({ EMBEDDER: "hashing", EMBEDDING_DIMENSIONS: "abc" })).toThrow(/positive integer/);
  });

  // Paid call: only with an explicit opt-in (npm run test:live) and a key.
  const hasKey = process.env.RUN_LIVE_TESTS === "1" && Boolean(process.env.OPENAI_API_KEY);
  (hasKey ? it : it.skip)("real OpenAI embedding returns the requested dimensions", async () => {
    const e = new AiSdkEmbedder("openai", "text-embedding-3-small", { dimensions: 256 });
    const [v] = await e.embed(["the user lives in Lisbon"]);
    expect(v).toHaveLength(256);
  }, 30_000);
});
