import type pg from "pg";
import { withTransaction } from "../../../platform/postgres/pool.js";
import type { UnitOfWork } from "../../ports/repositories.js";
import { PgBankRepository, PgEpisodeRepository, PgFactRepository, PgOutbox } from "./repositories.js";

/** One transaction per `run`; repositories and outbox share the same client. */
export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: pg.Pool) {}

  run<T>(work: Parameters<UnitOfWork["run"]>[0] extends (tx: infer Tx) => Promise<infer _R> ? (tx: Tx) => Promise<T> : never): Promise<T> {
    return withTransaction(this.pool, (client) =>
      work({
        banks: new PgBankRepository(client),
        episodes: new PgEpisodeRepository(client),
        facts: new PgFactRepository(client),
        outbox: new PgOutbox(client),
      }),
    );
  }
}
