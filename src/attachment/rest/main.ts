import { serve } from "@hono/node-server";
import { systemClock, type ModelRef } from "../../shared-kernel/index.js";
import { createPool } from "../../platform/postgres/pool.js";
import { migrate } from "../../platform/postgres/migrator.js";
import { migrationSources } from "../../platform/postgres/migrations.js";
import { PgAuditLog, PgErasureRequestRepository, PgErasureUnitOfWork, PgPrincipalRepository, ScopeResolver, scopeAccessPolicy } from "../../governance/index.js";
import { PgBankRepository, PgEpisodeRepository, PgFactRepository, PgMemoryErasure, PgOutboxRelay, PgUnitOfWork, WriteExtractedFactsHandler } from "../../memory/index.js";
import { embedderFromEnv, EngineErasableStore, EngineMemoryFinder, IndexingProjector, PgvectorEngine } from "../../retrieval/index.js";
import { AiSdkLlmClient, ExtractionErasableStore, LlmExtractor, PgExtractionRunStore, RetainPipeline, type Extractor } from "../../extraction/index.js";
import { ExportsErasableStore, PgExportStore } from "../../portability/index.js";
import { createApp } from "./app.js";

/**
 * Composition root for the REST attachment. One process: HTTP server plus the outbox relay
 * loop that (1) projects Memory events into the retrieval engine and (2) runs extraction on
 * new episodes for banks that have an extractor configured (`admin set-extractor`).
 *
 * Env: DATABASE_URL (required), PORT (default 8787), OUTBOX_POLL_MS (default 500),
 * EXTRACTION_POLL_MS (default 1000), LLM_TIMEOUT_MS (default 120000),
 * SHUTDOWN_TIMEOUT_MS (default 10000), plus the provider keys the configured extractor models
 * need (ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, OPENAI_API_KEY,
 * OPENAI_COMPATIBLE_BASE_URL). EMBEDDER selects the embedding model ("provider:model", default
 * openai:text-embedding-3-small; "hashing" for the offline test double), EMBEDDING_DIMENSIONS and
 * EMBEDDER_TIMEOUT_MS are optional. Changing the embedder requires `admin reindex --bank <id>` for
 * existing banks and a server restart (the server keeps the embedder it booted with).
 * Migrations run at boot, so the database role needs DDL rights.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (see .env.example)");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8787);
const pollMs = Number(process.env.OUTBOX_POLL_MS ?? 500);
const extractionPollMs = Number(process.env.EXTRACTION_POLL_MS ?? 1_000);
const llmTimeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 120_000);
const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000);

const pool = createPool(url);
await migrate(pool, migrationSources);

const embedder = embedderFromEnv();
// One tiny call at boot: fail fast on a bad key or model instead of dead-lettering every event later.
await embedder.embed(["startup probe"]);
const engine = new PgvectorEngine(pool, embedder);
for (const f of await engine.foreignEmbedders()) {
  console.warn(`index has ${f.rows} row(s) from embedder "${f.embedder}" that recall ignores; run \`npm run admin -- reindex --bank <id>\` for affected banks`);
}
const banks = new PgBankRepository(pool);
const facts = new PgFactRepository(pool);
const episodes = new PgEpisodeRepository(pool);
const uow = new PgUnitOfWork(pool);
const runs = new PgExtractionRunStore(pool);
const exports = new PgExportStore(pool);
const memoryErasure = new PgMemoryErasure(pool);

const app = createApp({
  scopes: new ScopeResolver(new PgPrincipalRepository(pool), banks, systemClock),
  access: scopeAccessPolicy,
  audit: new PgAuditLog(pool),
  clock: systemClock,
  uow,
  banks,
  facts,
  episodes,
  finder: new EngineMemoryFinder(engine),
  exports,
  // Every store that holds Subject data, Memory first. A new store (engine adapter, cache) must be listed here or erasure cannot prove it empty.
  erasure: {
    bank: memoryErasure,
    requests: new PgErasureRequestRepository(pool),
    uow: new PgErasureUnitOfWork(pool),
    stores: [memoryErasure, new EngineErasableStore(engine), new ExtractionErasableStore(runs), new ExportsErasableStore(exports)],
  },
});

// Extractors are created lazily per configured model and cached for the process lifetime.
const extractors = new Map<string, Extractor>();
const extractorFor = (model: ModelRef): Extractor => {
  const key = `${model.provider}:${model.model}@${model.version}`;
  let e = extractors.get(key);
  if (!e) {
    e = new LlmExtractor(new AiSdkLlmClient(model, { timeoutMs: llmTimeoutMs }));
    extractors.set(key, e);
  }
  return e;
};

const relay = new PgOutboxRelay(pool);
const projector = new IndexingProjector(engine, facts, episodes);
const pipeline = new RetainPipeline({
  banks,
  episodes,
  facts,
  runs,
  extractorFor,
  write: new WriteExtractedFactsHandler(uow, scopeAccessPolicy, systemClock),
  clock: systemClock,
  staleClaimMs: Math.max(2 * llmTimeoutMs, 10 * 60_000),
});

// Loop 1: outbox relay. Fast consumers only: index, and enqueue extraction work.
let draining = false;
let lastDeadLetters = 0;
const timer = setInterval(async () => {
  if (draining) return;
  draining = true;
  try {
    await relay.drainAll(async (events) => {
      await projector.handle(events);
      await pipeline.handle(events);
    });
    const dead = await relay.deadLetterCount();
    if (dead !== lastDeadLetters) {
      console.warn(`outbox: ${dead} dead-lettered event(s); inspect memory.outbox where failed_at is not null`);
      lastDeadLetters = dead;
    }
  } catch (e) {
    console.error("outbox relay error", e);
  } finally {
    draining = false;
  }
}, pollMs);

// Loop 2: extraction worker. Model calls happen here, never inside the relay's transaction.
let extracting = false;
const extractionTimer = setInterval(async () => {
  if (extracting) return;
  extracting = true;
  try {
    await pipeline.drain();
  } catch (e) {
    console.error("extraction worker error", e);
  } finally {
    extracting = false;
  }
}, extractionPollMs);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`mem REST attachment listening on http://localhost:${info.port} (embedder: ${embedder.id}, ${embedder.dimensions ?? "?"} dims, engine: ${engine.name}, extraction: per-bank)`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  clearInterval(timer);
  clearInterval(extractionTimer);
  const deadline = Date.now() + shutdownTimeoutMs;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, shutdownTimeoutMs).unref());
  try {
    await Promise.race([closed, timeout]);
    while ((draining || extracting) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error("shutdown error", e);
    process.exit(1);
  }
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void shutdown(signal));
