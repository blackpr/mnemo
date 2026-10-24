import type pg from "pg";
import type { BankId, SubjectId, TenantId } from "../../../shared-kernel/index.js";
import { withTransaction } from "../../../platform/postgres/pool.js";
import type { ErasableStore, ErasureBankGateway } from "../../../governance/index.js";
import { beginErasure, markErased, type Bank } from "../../domain/bank.js";
import { PgBankRepository } from "./repositories.js";

/**
 * Memory's side of the Erasure workflow (Governance ports, Memory adapter).
 *
 * `purge` deletes the bank's facts, episodes and outbox rows in ONE transaction with the session
 * flag `mem.erasure = 'on'` (SET LOCAL, so it dies with the transaction): the append-only
 * triggers in 0001_memory.sql refuse DELETE without it, which keeps every other code path
 * unable to delete by accident. Facts are deleted in a single statement so the self-referencing
 * supersession links inside the bank do not trip the foreign keys. Unpublished outbox events go
 * too; otherwise the relay would re-index data that no longer exists.
 * The bank row is never deleted: it ends as a tombstone with status `erased`.
 */
export class PgMemoryErasure implements ErasableStore, ErasureBankGateway {
  constructor(private readonly pool: pg.Pool) {}

  async describe(bankId: BankId): Promise<{ readonly tenantId: TenantId; readonly subjectId: SubjectId; readonly engine: string; readonly status: string } | undefined> {
    const bank = await new PgBankRepository(this.pool).get(bankId);
    return bank ? { tenantId: bank.tenantId, subjectId: bank.subjectId, engine: bank.engine, status: bank.status } : undefined;
  }

  /** Locks the bank row, so the freeze waits for every writer that already passed its status check and later writers see `erasing`. */
  async beginErasure(bankId: BankId): Promise<{ readonly engine: string }> {
    const frozen = await this.transition(bankId, beginErasure);
    return { engine: frozen.engine };
  }

  async completeErasure(bankId: BankId): Promise<void> {
    await this.transition(bankId, markErased);
  }

  private transition(bankId: BankId, next: (bank: Bank) => Bank): Promise<Bank> {
    return withTransaction(this.pool, async (client) => {
      const banks = new PgBankRepository(client);
      const bank = await banks.get(bankId, { lock: "update" });
      if (!bank) throw new Error(`Bank ${bankId} not found`);
      const after = next(bank);
      await banks.update(after);
      return after;
    });
  }

  async count(bankId: BankId): Promise<Readonly<Record<string, number>>> {
    const { rows } = await this.pool.query<{ facts: string; episodes: string; outbox: string }>(
      `SELECT (SELECT count(*) FROM memory.facts WHERE bank_id = $1)::text AS facts,
              (SELECT count(*) FROM memory.episodes WHERE bank_id = $1)::text AS episodes,
              (SELECT count(*) FROM memory.outbox WHERE bank_id = $1)::text AS outbox`,
      [bankId],
    );
    const r = rows[0];
    return { "memory.facts": Number(r?.facts ?? 0), "memory.episodes": Number(r?.episodes ?? 0), "memory.outbox": Number(r?.outbox ?? 0) };
  }

  purge(bankId: BankId): Promise<Readonly<Record<string, number>>> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SET LOCAL mem.erasure = 'on'");
      const facts = await client.query("DELETE FROM memory.facts WHERE bank_id = $1", [bankId]);
      const episodes = await client.query("DELETE FROM memory.episodes WHERE bank_id = $1", [bankId]);
      const outbox = await client.query("DELETE FROM memory.outbox WHERE bank_id = $1", [bankId]);
      return { "memory.facts": facts.rowCount ?? 0, "memory.episodes": episodes.rowCount ?? 0, "memory.outbox": outbox.rowCount ?? 0 };
    });
  }
}
