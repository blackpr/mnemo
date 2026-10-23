import type pg from "pg";
import { PgErasureRequestRepository, PgErasureUnitOfWork } from "../../src/governance/index.js";
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
    stores: [memory, new EngineErasableStore(engine), new ExtractionErasableStore(new PgExtractionRunStore(pool)), new ExportsErasableStore(new PgExportStore(pool))],
  };
}
