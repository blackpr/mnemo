import { describe, expect, it } from "vitest";
import { engineFromEnv, HashingEmbedder, HindsightEngine, HonchoEngine, PgvectorEngine } from "../../src/retrieval/index.js";

/** Pure selection logic; no engine is contacted (constructing an adapter opens no connection). */
describe("engineFromEnv", () => {
  const db = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Parameters<typeof engineFromEnv>[0];
  const embedder = new HashingEmbedder(16);

  it("defaults to pgvector", () => {
    expect(engineFromEnv(db, embedder, {})).toBeInstanceOf(PgvectorEngine);
    expect(engineFromEnv(db, embedder, { ENGINE: "pgvector" }).name).toBe("pgvector");
  });

  it("selects hindsight and honcho from their base URLs", () => {
    expect(engineFromEnv(db, embedder, { ENGINE: "hindsight", HINDSIGHT_BASE_URL: "http://127.0.0.1:8888" })).toBeInstanceOf(HindsightEngine);
    expect(engineFromEnv(db, embedder, { ENGINE: "honcho", HONCHO_BASE_URL: "http://127.0.0.1:8010", HONCHO_API_KEY: "x" })).toBeInstanceOf(HonchoEngine);
  });

  it("fails fast on a missing URL or an unknown engine", () => {
    expect(() => engineFromEnv(db, embedder, { ENGINE: "hindsight" })).toThrow(/HINDSIGHT_BASE_URL/);
    expect(() => engineFromEnv(db, embedder, { ENGINE: "honcho" })).toThrow(/HONCHO_BASE_URL/);
    expect(() => engineFromEnv(db, embedder, { ENGINE: "mem0" })).toThrow(/ENGINE must be one of/);
  });
});
