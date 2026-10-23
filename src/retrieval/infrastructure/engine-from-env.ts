import type { Queryable } from "../../platform/postgres/pool.js";
import type { Embedder } from "../ports/embedder.js";
import type { RetrievalEngine } from "../ports/retrieval-engine.js";
import { PgvectorEngine } from "./pgvector/pgvector-engine.js";
import { HindsightEngine } from "./hindsight/hindsight-engine.js";
import { HonchoEngine } from "./honcho/honcho-engine.js";

export const ENGINE_NAMES = ["pgvector", "hindsight", "honcho"] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

/**
 * `ENGINE` selects the RetrievalEngine the server and the admin CLI use, the way `EMBEDDER`
 * selects the embedder: `pgvector` (default; our Postgres, needs the embedder), `hindsight`
 * (HINDSIGHT_BASE_URL, HINDSIGHT_API_KEY) or `honcho` (HONCHO_BASE_URL, HONCHO_API_KEY). The two
 * external engines embed on their own side, so the embedder (or its factory, which is then never
 * called) is only used for pgvector. Optional ENGINE_NAMESPACE (default `mem-`) prefixes the bank /
 * workspace names inside the engine.
 */
export function engineFromEnv(db: Queryable, embedder: Embedder | (() => Embedder), env: NodeJS.ProcessEnv = process.env): RetrievalEngine {
  const name = env.ENGINE ?? "pgvector";
  const prefix = env.ENGINE_NAMESPACE ?? "mem-";
  switch (name) {
    case "pgvector":
      return new PgvectorEngine(db, typeof embedder === "function" ? embedder() : embedder);
    case "hindsight":
      return new HindsightEngine({ baseUrl: required(env, "HINDSIGHT_BASE_URL"), bankPrefix: prefix, ...optional(env, "HINDSIGHT_API_KEY", "apiKey") });
    case "honcho":
      return new HonchoEngine({ baseUrl: required(env, "HONCHO_BASE_URL"), workspacePrefix: prefix, ...optional(env, "HONCHO_API_KEY", "apiKey") });
    default:
      throw new Error(`ENGINE must be one of ${ENGINE_NAMES.join(", ")}; got "${name}"`);
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is not set (see .env.example); required for ENGINE=${env.ENGINE}`);
  return v;
}

function optional(env: NodeJS.ProcessEnv, key: string, as: "apiKey"): { apiKey?: string } {
  const v = env[key];
  return v ? { [as]: v } : {};
}
