import { serve } from "@hono/node-server";
import { systemClock, type ModelRef } from "../../shared-kernel/index.js";
import { createPool } from "../../platform/postgres/pool.js";
import { migrate } from "../../platform/postgres/migrator.js";
import { migrationSources } from "../../platform/postgres/migrations.js";
import { PgAccessRevocation, PgAuditLog, PgErasureRequestRepository, PgErasureUnitOfWork, PgPrincipalRepository, ScopeResolver, scopeAccessPolicy } from "../../governance/index.js";
import { PgBankRepository, PgEpisodeRepository, PgFactRepository, PgMemoryErasure, PgOutboxRelay, PgUnitOfWork, WriteExtractedFactsHandler } from "../../memory/index.js";
import { embedderFromEnv, embeddingDimensionsFromEnv, engineFromEnv, EngineErasableStore, EngineMemoryFinder, IndexingProjector, PgvectorEngine, readPinnedIndex } from "../../retrieval/index.js";
import { AiSdkLlmClient, ExtractionErasableStore, LlmExtractor, PgExtractionRunStore, RetainPipeline, type Extractor } from "../../extraction/index.js";
import { ExportsErasableStore, PgExportStore } from "../../portability/index.js";
import { ADDRESS_LIMIT_FACTOR, createApp, DEFAULT_RATE_LIMIT_PER_MINUTE } from "./app.js";

/**
 * Composition root for the REST attachment. One process: HTTP server plus the outbox relay
 * loop that (1) projects Memory events into the retrieval engine and (2) runs extraction on
 * new episodes for banks that have an extractor configured (`admin set-extractor`).
 *
 * Env: DATABASE_URL (required), PORT (default 8787), RATE_LIMIT_PER_MINUTE (default 600 requests per API
 * key per minute under /v1, REST and MCP; 0 disables) and RATE_LIMIT_PER_ADDRESS_PER_MINUTE (default ten
 * times that, per client address; 0 means no address ceiling; in-process counters, see app.ts), OUTBOX_POLL_MS (default 500),
 * EXTRACTION_POLL_MS (default 1000), LLM_TIMEOUT_MS (default 120000),
 * SHUTDOWN_TIMEOUT_MS (default 10000), plus the provider keys the configured extractor models
 * need (ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, OPENAI_API_KEY,
 * OPENAI_COMPATIBLE_BASE_URL). EMBEDDER selects the embedding model ("provider:model", default
 * openai:text-embedding-3-small; "hashing" for the offline test double); EMBEDDING_DIMENSIONS (default
 * 1536) is the width the embedder must produce and the pgvector index is pinned to (`admin
 * pin-dimensions`): the boot probe refuses to start on a mismatch with either. EMBEDDER_TIMEOUT_MS is
 * optional. Changing the embedder requires `admin reindex --bank <id>` for existing banks and a
 * server restart (the server keeps the embedder it booted with). ENGINE selects
 * the retrieval engine ("pgvector" default, "hindsight" with HINDSIGHT_BASE_URL / HINDSIGHT_API_KEY,
 * "honcho" with HONCHO_BASE_URL / HONCHO_API_KEY; see src/retrieval/infrastructure/README.md);
 * switching engines also needs `admin reindex --bank <id>` since each engine holds its own derived state.
 * Migrations run at boot, so the database role needs DDL rights.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (see .env.example)");
  process.exit(1);
}
/** Digits only: "1e3" or " 600 " are configuration mistakes, not limits. 0 is allowed and means "off" for both limits. */
function nonNegativeInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) {
    console.error(`${name} must be a non-negative integer (0 turns that limit off), got "${raw}"`);
    process.exit(1);
  }
  return Number(raw);
}
const port = Number(process.env.PORT ?? 8787);
const pollMs = Number(process.env.OUTBOX_POLL_MS ?? 500);
const extractionPollMs = Number(process.env.EXTRACTION_POLL_MS ?? 1_000);
const llmTimeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 120_000);
const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000);
const rateLimitPerMinute = nonNegativeInt("RATE_LIMIT_PER_MINUTE") ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
const rateLimitPerAddressPerMinute = nonNegativeInt("RATE_LIMIT_PER_ADDRESS_PER_MINUTE") ?? rateLimitPerMinute * ADDRESS_LIMIT_FACTOR;
if (rateLimitPerMinute > 0 && rateLimitPerAddressPerMinute > 0 && rateLimitPerAddressPerMinute < rateLimitPerMinute) {
  console.warn(`RATE_LIMIT_PER_ADDRESS_PER_MINUTE (${rateLimitPerAddressPerMinute}) is below RATE_LIMIT_PER_MINUTE (${rateLimitPerMinute}): every client hits the address ceiling before its own limit`);
}

const pool = createPool(url);
await migrate(pool, migrationSources);

// The embedder is pgvector's; the external engines embed on their side, so it is neither built nor probed for them.
const engine = engineFromEnv(pool, embedderFromEnv);
if (engine instanceof PgvectorEngine) {
  // The width is pinned twice: by EMBEDDING_DIMENSIONS and, once `admin pin-dimensions` ran, by the index
  // column. A mismatch with either would dead-letter every projection (or recall against the wrong space).
  // The pin is checked first so a plain misconfiguration is refused without a provider call.
  const expectedDims = embeddingDimensionsFromEnv();
  const pinned = await readPinnedIndex(pool);
  if (pinned && pinned.dimensions !== expectedDims) {
    console.error(`retrieval index is pinned to ${pinned.dimensions} dimensions (embedder ${pinned.embedder}) but EMBEDDING_DIMENSIONS is ${expectedDims}; run \`npm run admin -- pin-dimensions\` to re-pin (it deletes rows from other embedders) and \`admin reindex --bank <id>\` for every bank, refusing to start`);
    process.exit(1);
  }
  // One tiny call at boot: fail fast on a bad key or model instead of dead-lettering every event later.
  await engine.probeEmbedder();
  if (engine.embedderDimensions !== expectedDims) {
    console.error(`EMBEDDER ${engine.embedderId} produces ${engine.embedderDimensions ?? "?"} dimensions but EMBEDDING_DIMENSIONS is ${expectedDims} (default 1536); set EMBEDDING_DIMENSIONS=${engine.embedderDimensions ?? "<width>"}, which changes the embedder id, then \`admin pin-dimensions --yes\` and \`admin reindex --bank <id>\` for every bank; refusing to start`);
    process.exit(1);
  }
  if (!pinned) console.warn("retrieval index is not pinned yet (untyped column, no HNSW index): run `npm run admin -- pin-dimensions` once");
  else if (pinned.embedder !== engine.embedderId) console.warn(`retrieval index was pinned for embedder "${pinned.embedder}", the server runs "${engine.embedderId}" (same width); run \`npm run admin -- pin-dimensions\` and \`admin reindex --bank <id>\` for affected banks`);
  for (const f of await engine.foreignEmbedders()) {
    console.warn(`index has ${f.rows} row(s) from embedder "${f.embedder}" that recall ignores; run \`npm run admin -- reindex --bank <id>\` for affected banks`);
  }
}
const banks = new PgBankRepository(pool);
const facts = new PgFactRepository(pool);
const episodes = new PgEpisodeRepository(pool);
const uow = new PgUnitOfWork(pool);
const runs = new PgExtractionRunStore(pool);
const exports = new PgExportStore(pool);
const memoryErasure = new PgMemoryErasure(pool);

const app = createApp(
  {
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
  // Every store that holds Subject data, Memory first, then access to it last (so a data-store failure leaves the
  // eraser able to retry). A new store (engine adapter, cache) must be listed here or erasure cannot prove it empty.
  erasure: {
    bank: memoryErasure,
    requests: new PgErasureRequestRepository(pool),
    uow: new PgErasureUnitOfWork(pool),
    stores: [memoryErasure, new EngineErasableStore(engine), new ExtractionErasableStore(runs), new ExportsErasableStore(exports), new PgAccessRevocation(pool)],
  },
  },
  { rateLimitPerMinute, rateLimitPerAddressPerMinute },
);

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
  console.log(`mem REST attachment listening on http://localhost:${info.port} (engine: ${engine.name}${engine instanceof PgvectorEngine ? `, embedder: ${engine.embedderId}, ${engine.embedderDimensions ?? "?"} dims` : ""}, extraction: per-bank, rate limit: ${rateLimitPerMinute === 0 ? "off" : `${rateLimitPerMinute}/min per key, ${rateLimitPerAddressPerMinute}/min per address`})`);
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
