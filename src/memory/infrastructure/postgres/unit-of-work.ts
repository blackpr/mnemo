import type pg from "pg";
import { withTransaction } from "../../../platform/postgres/pool.js";
import { PgAuditLog } from "../../../governance/index.js";
import type { TransactionalRepositories, UnitOfWork } from "../../ports/repositories.js";
import { PgBankRepository, PgEpisodeRepository, PgFactRepository, PgOutbox } from "./repositories.js";

/** One transaction per `run`; repositories, outbox and audit log share the same client. */
export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: pg.Pool) {}

  run<T>(work: (tx: TransactionalRepositories) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, (client) =>
      work({
        banks: new PgBankRepository(client),
        episodes: new PgEpisodeRepository(client),
        facts: new PgFactRepository(client),
        outbox: new PgOutbox(client),
        audit: PgAuditLog.onClient(client),
      }),
    );
  }
}
