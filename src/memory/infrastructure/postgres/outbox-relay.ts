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
  attempts: number;
}

export type OutboxHandler = (events: readonly DomainEvent[]) => Promise<void>;

export interface RelayOptions {
  readonly batchSize?: number;
  /** After this many failed deliveries an event is dead-lettered (failed_at set) and skipped. */
  readonly maxAttempts?: number;
  /** Delay before retrying an event that has failed `attempts` times. Default: exponential, 1s · 2^(attempts-1), capped at 5 min. */
  readonly backoffMs?: (attempts: number) => number;
}

export const exponentialBackoffMs = (attempts: number): number => Math.min(300_000, 1000 * 2 ** Math.max(0, attempts - 1));

/**
 * Outbox relay: delivers due, unpublished events to a handler one event at a time, inside one
 * transaction per batch. Rows are locked with FOR UPDATE SKIP LOCKED so several relays can run
 * concurrently. Each event's bookkeeping runs under a SAVEPOINT so a failure for one event
 * cannot abort the batch's transaction; the handler itself runs on its own connections, so what
 * makes redelivery safe is consumer idempotency (indexing is an upsert, retraction is a flag),
 * not the savepoint. A failed event gets its attempt count bumped and a backoff before its next
 * try; after maxAttempts it is dead-lettered and skipped. Delivery is at-least-once.
 */
export class PgOutboxRelay {
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempts: number) => number;

  constructor(
    private readonly pool: pg.Pool,
    opts: RelayOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? 100;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.backoffMs = opts.backoffMs ?? exponentialBackoffMs;
  }

  /** Drain one batch. Returns delivered and failed counts. */
  async drainOnce(handler: OutboxHandler): Promise<{ readonly delivered: number; readonly failed: number; readonly seen: number }> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<OutboxRow>(
        `SELECT id, type, occurred_at, tenant_id, bank_id, payload, attempts
         FROM memory.outbox
         WHERE published_at IS NULL AND failed_at IS NULL AND next_attempt_at <= now()
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );
      let delivered = 0;
      let failed = 0;
      for (const r of rows) {
        const event: DomainEvent = { type: r.type, occurredAt: r.occurred_at, tenantId: r.tenant_id as TenantId, bankId: r.bank_id as BankId, payload: r.payload };
        await client.query("SAVEPOINT ev");
        try {
          await handler([event]);
          await client.query("UPDATE memory.outbox SET published_at = now() WHERE id = $1", [r.id]);
          await client.query("RELEASE SAVEPOINT ev");
          delivered++;
        } catch (e) {
          await client.query("ROLLBACK TO SAVEPOINT ev");
          const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          const attempts = r.attempts + 1;
          await client.query(
            `UPDATE memory.outbox
             SET attempts = $2::int, last_error = $3::text,
                 next_attempt_at = now() + ($4::int * interval '1 millisecond'),
                 failed_at = CASE WHEN $2::int >= $5::int THEN now() ELSE NULL END
             WHERE id = $1`,
            [r.id, attempts, message.slice(0, 2000), Math.round(this.backoffMs(attempts)), this.maxAttempts],
          );
          failed++;
        }
      }
      return { delivered, failed, seen: rows.length };
    });
  }

  /** Drain until a batch comes back smaller than batchSize or delivers nothing. Returns total delivered. */
  async drainAll(handler: OutboxHandler): Promise<number> {
    let total = 0;
    for (;;) {
      const r = await this.drainOnce(handler);
      total += r.delivered;
      if (r.seen < this.batchSize || r.delivered === 0) return total;
    }
  }

  /** Unpublished and not dead-lettered, whether or not currently in backoff. */
  async pendingCount(): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM memory.outbox WHERE published_at IS NULL AND failed_at IS NULL");
    return Number(rows[0]?.n ?? 0);
  }

  async deadLetterCount(): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM memory.outbox WHERE failed_at IS NOT NULL");
    return Number(rows[0]?.n ?? 0);
  }

  /** Operator action: put dead-lettered events back in the queue. */
  async requeueDeadLetters(): Promise<number> {
    const r = await this.pool.query("UPDATE memory.outbox SET failed_at = NULL, attempts = 0, next_attempt_at = now() WHERE failed_at IS NOT NULL AND published_at IS NULL");
    return r.rowCount ?? 0;
  }
}
