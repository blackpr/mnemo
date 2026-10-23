import { serve } from "@hono/node-server";
import { systemClock } from "../../shared-kernel/index.js";
import { createPool } from "../../platform/postgres/pool.js";
import { migrate } from "../../platform/postgres/migrator.js";
import { migrationSources } from "../../platform/postgres/migrations.js";
import { PgAuditLog, PgPrincipalRepository, ScopeResolver, scopeAccessPolicy } from "../../governance/index.js";
import { PgBankRepository, PgEpisodeRepository, PgFactRepository, PgOutboxRelay, PgUnitOfWork } from "../../memory/index.js";
import { EngineMemoryFinder, HashingEmbedder, IndexingProjector, PgvectorEngine } from "../../retrieval/index.js";
import { createApp } from "./app.js";

/**
 * Composition root for the REST attachment. One process: HTTP server plus the outbox relay
 * loop that projects Memory events into the retrieval engine.
 *
 * Env: DATABASE_URL (required), PORT (default 8787), OUTBOX_POLL_MS (default 500),
 * SHUTDOWN_TIMEOUT_MS (default 10000). Migrations run at boot, so the database role needs DDL
 * rights on the memory, governance and retrieval schemas.
 * Embedder is the offline HashingEmbedder until a production embedder is chosen in the spike.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (see .env.example)");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8787);
const pollMs = Number(process.env.OUTBOX_POLL_MS ?? 500);
const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000);

const pool = createPool(url);
await migrate(pool, migrationSources);

const embedder = new HashingEmbedder(256);
const engine = new PgvectorEngine(pool, embedder);
const facts = new PgFactRepository(pool);
const episodes = new PgEpisodeRepository(pool);

const app = createApp({
  scopes: new ScopeResolver(new PgPrincipalRepository(pool), new PgBankRepository(pool), systemClock),
  access: scopeAccessPolicy,
  audit: new PgAuditLog(pool),
  clock: systemClock,
  uow: new PgUnitOfWork(pool),
  facts,
  episodes,
  finder: new EngineMemoryFinder(engine),
});

const relay = new PgOutboxRelay(pool);
const projector = new IndexingProjector(engine, facts, episodes);
let draining = false;
let lastDeadLetters = 0;
const timer = setInterval(async () => {
  if (draining) return;
  draining = true;
  try {
    await relay.drainAll((events) => projector.handle(events));
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

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`mem REST attachment listening on http://localhost:${info.port} (embedder: ${embedder.id}, engine: ${engine.name})`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  clearInterval(timer);
  const deadline = Date.now() + shutdownTimeoutMs;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, shutdownTimeoutMs).unref());
  try {
    await Promise.race([closed, timeout]);
    while (draining && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error("shutdown error", e);
    process.exit(1);
  }
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void shutdown(signal));
