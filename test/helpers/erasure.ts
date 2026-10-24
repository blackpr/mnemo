import { randomUUID } from "node:crypto";
import type pg from "pg";
import { ok, systemClock, type BankId, type Result, type Scope } from "../../src/shared-kernel/index.js";
import { EraseBankHandler, ErasureWorker, PgAccessRevocation, PgErasureRequestRepository, PgErasureUnitOfWork, scopeAccessPolicy, type EraseBankError, type ErasureRequest, type ErasureWorkerOptions } from "../../src/governance/index.js";
import { sha256 } from "../../src/platform/hash.js";
import { PgMemoryErasure } from "../../src/memory/index.js";
import { EngineErasableStore, type RetrievalEngine } from "../../src/retrieval/index.js";
import { ExtractionErasableStore, PgExtractionRunStore } from "../../src/extraction/index.js";
import { ExportsErasableStore, PgExportStore } from "../../src/portability/index.js";
import type { ErasureDeps } from "../../src/attachment/handlers.js";

/** The production wiring of every store that holds Subject data, against the test database. Mirrors src/attachment/rest/main.ts. */
export function erasureDeps(pool: pg.Pool, engine: RetrievalEngine): ErasureDeps {
  const memory = new PgMemoryErasure(pool);
  return {
    bank: memory,
    requests: new PgErasureRequestRepository(pool),
    uow: new PgErasureUnitOfWork(pool),
    stores: [memory, new EngineErasableStore(engine), new ExtractionErasableStore(new PgExtractionRunStore(pool)), new ExportsErasableStore(new PgExportStore(pool)), new PgAccessRevocation(pool)],
  };
}

/** The server's erasure worker over the same deps; tests run one pass on demand (`drain()` / `processNext()`) like the extraction tests do. */
export function erasureWorker(deps: ErasureDeps, opts: ErasureWorkerOptions = {}): ErasureWorker {
  return new ErasureWorker(deps.requests, deps.bank, deps.uow, deps.stores, systemClock, sha256, opts);
}

/** Request an erasure and run the worker until the queue is empty, then read the request back: what the REST handler plus the server's loop do. */
export async function eraseNow(deps: ErasureDeps, scope: Scope, bankId: BankId, opts: ErasureWorkerOptions = {}): Promise<Result<ErasureRequest, EraseBankError>> {
  const r = await new EraseBankHandler(scopeAccessPolicy, deps.bank, deps.uow, deps.stores, systemClock, randomUUID).handle(scope, bankId);
  if (!r.ok) return r;
  await erasureWorker(deps, opts).drain();
  const stored = await deps.requests.get(r.value.id);
  if (!stored) throw new Error(`erasure ${r.value.id} vanished`);
  return ok(stored);
}
