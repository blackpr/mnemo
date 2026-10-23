import type { BankId, DomainEvent, EpisodeId, FactId, PrincipalId, Scope, TenantId } from "../../../shared-kernel/index.js";
import type { Queryable } from "../../../platform/postgres/pool.js";
import type { Bank } from "../../domain/bank.js";
import type { Episode } from "../../domain/episode.js";
import type { Fact } from "../../domain/fact.js";
import { DuplicateEpisodeError, DuplicateFactError, type BankRepository, type EpisodeRepository, type FactRepository, type Outbox } from "../../ports/repositories.js";
import { factToParams, toBank, toEpisode, toFact, type BankRow, type EpisodeRow, type FactRow } from "./rows.js";

/**
 * Postgres adapters for the Memory ports. Every read filters by scope.bankId in SQL as a
 * second line of defence behind Governance's AccessPolicy (which the application layer
 * has already applied). Repositories take a Queryable so they run on a pool or inside a
 * unit-of-work transaction.
 */

export class PgBankRepository implements BankRepository {
  constructor(private readonly db: Queryable) {}

  async get(bankId: BankId, opts: { readonly lock?: "share" | "update" } = {}): Promise<Bank | undefined> {
    const lock = opts.lock === "share" ? " FOR SHARE" : opts.lock === "update" ? " FOR UPDATE" : "";
    const { rows } = await this.db.query<BankRow>(`SELECT * FROM memory.banks WHERE id = $1${lock}`, [bankId]);
    return rows[0] ? toBank(rows[0]) : undefined;
  }

  async tenantOf(bankId: BankId): Promise<TenantId | undefined> {
    const { rows } = await this.db.query<{ tenant_id: string }>("SELECT tenant_id FROM memory.banks WHERE id = $1", [bankId]);
    return rows[0] ? (rows[0].tenant_id as TenantId) : undefined;
  }

  async create(bank: Bank): Promise<void> {
    await this.db.query(
      `INSERT INTO memory.banks (id, tenant_id, subject_id, status, policy, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [bank.id, bank.tenantId, bank.subjectId, bank.status, JSON.stringify(bank.policy), bank.createdAt],
    );
  }

  async update(bank: Bank): Promise<void> {
    const r = await this.db.query("UPDATE memory.banks SET status = $2, policy = $3 WHERE id = $1 AND tenant_id = $4 AND subject_id = $5", [
      bank.id,
      bank.status,
      JSON.stringify(bank.policy),
      bank.tenantId,
      bank.subjectId,
    ]);
    if (r.rowCount === 0) throw new Error(`Bank ${bank.id} not found (or tenant/subject mismatch)`);
  }
}

export class PgEpisodeRepository implements EpisodeRepository {
  constructor(private readonly db: Queryable) {}

  async append(e: Episode): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO memory.episodes (id, bank_id, kind, source, role, text, occurred_at, recorded_at, recorded_by, external_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [e.id, e.bankId, e.kind, e.source, e.role ?? null, e.text, e.occurredAt, e.recordedAt, e.recordedBy, e.externalRef ?? null],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateEpisodeError(e.id);
      throw err;
    }
  }

  async get(scope: Scope, id: EpisodeId): Promise<Episode | undefined> {
    const { rows } = await this.db.query<EpisodeRow>("SELECT * FROM memory.episodes WHERE bank_id = $1 AND id = $2", [scope.bankId, id]);
    return rows[0] ? toEpisode(rows[0]) : undefined;
  }

  async getMany(scope: Scope, ids: readonly EpisodeId[]): Promise<readonly Episode[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.db.query<EpisodeRow>("SELECT * FROM memory.episodes WHERE bank_id = $1 AND id = ANY($2::text[])", [scope.bankId, ids]);
    return rows.map(toEpisode);
  }

  async listRecent(scope: Scope, limit: number, before: Date = new Date()): Promise<readonly Episode[]> {
    const { rows } = await this.db.query<EpisodeRow>(
      `SELECT * FROM (
         SELECT * FROM memory.episodes WHERE bank_id = $1 AND occurred_at <= $2
         ORDER BY occurred_at DESC, id DESC LIMIT $3
       ) recent ORDER BY occurred_at ASC, id ASC`,
      [scope.bankId, before, limit],
    );
    return rows.map(toEpisode);
  }

  async listByBank(scope: Scope, opts: { readonly after?: Date; readonly limit?: number } = {}): Promise<readonly Episode[]> {
    const { rows } = await this.db.query<EpisodeRow>(
      `SELECT * FROM memory.episodes
       WHERE bank_id = $1 AND ($2::timestamptz IS NULL OR occurred_at > $2)
       ORDER BY occurred_at ASC, id ASC
       LIMIT $3`,
      [scope.bankId, opts.after ?? null, opts.limit ?? 1000],
    );
    return rows.map(toEpisode);
  }
}

export class PgFactRepository implements FactRepository {
  constructor(private readonly db: Queryable) {}

  async insert(f: Fact): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO memory.facts
           (id, bank_id, statement, predicate, valid_from, valid_to, recorded_at, retracted_at, provenance, supersedes_id, superseded_by_id, invalidation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        factToParams(f),
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateFactError(f.id);
      throw err;
    }
  }

  async update(f: Fact): Promise<void> {
    const { rowCount } = await this.db.query(
      `UPDATE memory.facts SET
         statement = $3, predicate = $4, valid_from = $5, valid_to = $6, recorded_at = $7, retracted_at = $8,
         provenance = $9, supersedes_id = $10, superseded_by_id = $11, invalidation = $12
       WHERE id = $1 AND bank_id = $2`,
      factToParams(f),
    );
    if (rowCount === 0) throw new Error(`Fact ${f.id} not found in bank ${f.bankId}`);
  }

  async get(scope: Scope, id: FactId, opts: { readonly forUpdate?: boolean } = {}): Promise<Fact | undefined> {
    const { rows } = await this.db.query<FactRow>(`SELECT * FROM memory.facts WHERE bank_id = $1 AND id = $2${opts.forUpdate ? " FOR UPDATE" : ""}`, [scope.bankId, id]);
    return rows[0] ? toFact(rows[0]) : undefined;
  }

  async getMany(scope: Scope, ids: readonly FactId[]): Promise<readonly Fact[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.db.query<FactRow>("SELECT * FROM memory.facts WHERE bank_id = $1 AND id = ANY($2::text[])", [scope.bankId, ids]);
    return rows.map(toFact);
  }

  async listAll(scope: Scope): Promise<readonly Fact[]> {
    const { rows } = await this.db.query<FactRow>("SELECT * FROM memory.facts WHERE bank_id = $1 ORDER BY valid_from ASC, id ASC", [scope.bankId]);
    return rows.map(toFact);
  }

  async existsForTrigger(scope: Scope, triggerEpisodeId: EpisodeId, writer: PrincipalId): Promise<boolean> {
    const { rows } = await this.db.query<{ one: number }>(
      `SELECT 1 AS one FROM memory.facts
       WHERE bank_id = $1 AND provenance->>'triggerEpisodeId' = $2 AND provenance->>'writerPrincipalId' = $3
       LIMIT 1`,
      [scope.bankId, triggerEpisodeId, writer],
    );
    return rows.length > 0;
  }

  async listCurrent(scope: Scope, at: Date = new Date()): Promise<readonly Fact[]> {
    const { rows } = await this.db.query<FactRow>(
      `SELECT * FROM memory.facts
       WHERE bank_id = $1 AND retracted_at IS NULL
         AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)
       ORDER BY valid_from ASC, id ASC`,
      [scope.bankId, at],
    );
    return rows.map(toFact);
  }
}

export class PgOutbox implements Outbox {
  constructor(private readonly db: Queryable) {}

  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const e of events) {
      await this.db.query(
        "INSERT INTO memory.outbox (type, occurred_at, tenant_id, bank_id, payload) VALUES ($1, $2, $3, $4, $5)",
        [e.type, e.occurredAt, e.tenantId, e.bankId, JSON.stringify(e.payload)],
      );
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
