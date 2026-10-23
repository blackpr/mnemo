import type pg from "pg";
import type { BankId, DomainEvent, TenantId } from "../../../shared-kernel/index.js";
import { withTransaction } from "../../../platform/postgres/pool.js";

interface OutboxRow {
  id: string;
  type: string;
  occurred_at: Date;
  tenant_id: string;
  bank_id: string;
  payload: unknown;
}

export type OutboxHandler = (events: readonly DomainEvent[]) => Promise<void>;

/**
 * Outbox relay: delivers unpublished events to a handler in batches, in a transaction.
 * Rows are locked with FOR UPDATE SKIP LOCKED so several relays can run concurrently.
 * If the handler throws, the transaction rolls back and the batch stays unpublished
 * (at-least-once delivery; consumers must be idempotent, keyed on event id/episode id).
 */
export class PgOutboxRelay {
  constructor(private readonly pool: pg.Pool) {}

  /** Drain one batch. Returns the number of events delivered. */
  async drainOnce(handler: OutboxHandler, batchSize = 100): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<OutboxRow>(
        `SELECT id, type, occurred_at, tenant_id, bank_id, payload
         FROM memory.outbox
         WHERE published_at IS NULL
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );
      if (rows.length === 0) return 0;

      const events: DomainEvent[] = rows.map((r) => ({
        type: r.type,
        occurredAt: r.occurred_at,
        tenantId: r.tenant_id as TenantId,
        bankId: r.bank_id as BankId,
        payload: r.payload,
      }));
      await handler(events);

      await client.query("UPDATE memory.outbox SET published_at = now() WHERE id = ANY($1::bigint[])", [rows.map((r) => r.id)]);
      return rows.length;
    });
  }

  /** Drain until empty. */
  async drainAll(handler: OutboxHandler, batchSize = 100): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.drainOnce(handler, batchSize);
      total += n;
      if (n < batchSize) return total;
    }
  }

  async pendingCount(): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM memory.outbox WHERE published_at IS NULL");
    return Number(rows[0]?.n ?? 0);
  }
}
