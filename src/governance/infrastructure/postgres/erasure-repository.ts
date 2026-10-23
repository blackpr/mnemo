import type { BankId, PrincipalId, SubjectId, TenantId } from "../../../shared-kernel/index.js";
import type pg from "pg";
import { withTransaction, type Queryable } from "../../../platform/postgres/pool.js";
import type { ErasureReceipt, ErasureRequest, ErasureState, StoreDeletion, StoreInventory, StoreVerification } from "../../domain/erasure-request.js";
import { ErasureInFlightError, ErasureNotInFlightError, type ErasureRequestRepository, type ErasureTransaction, type ErasureUnitOfWork } from "../../ports/repositories.js";
import { PgAuditLog } from "./repositories.js";

interface Row {
  id: string;
  tenant_id: string;
  bank_id: string;
  subject_id: string;
  requested_by: string;
  requested_at: Date;
  state: ErasureState;
  inventory: { store: string; countBefore: number }[];
  deletions: { store: string; deleted: number; deletedAt: string }[];
  verifications: { store: string; hitsAfter: number; checkedAt: string }[];
  updated_at: Date;
  receipt: {
    requestId: string;
    tenantId: string;
    bankId: string;
    subjectId: string;
    deletions: { store: string; deleted: number; deletedAt: string }[];
    stores: { store: string; hitsAfter: number; checkedAt: string }[];
    issuedAt: string;
    digest: string;
  } | null;
  failure: string | null;
}

// jsonb does not keep key order, so every nested object is rebuilt field by field.
const toInventory = (i: Row["inventory"][number]): StoreInventory => Object.freeze({ store: i.store, countBefore: i.countBefore });
const toDeletion = (d: Row["deletions"][number]): StoreDeletion => Object.freeze({ store: d.store, deleted: d.deleted, deletedAt: new Date(d.deletedAt) });
const toVerification = (v: Row["verifications"][number]): StoreVerification => Object.freeze({ store: v.store, hitsAfter: v.hitsAfter, checkedAt: new Date(v.checkedAt) });
const toReceipt = (r: NonNullable<Row["receipt"]>): ErasureReceipt =>
  Object.freeze({
    requestId: r.requestId,
    tenantId: r.tenantId as TenantId,
    bankId: r.bankId as BankId,
    subjectId: r.subjectId as SubjectId,
    deletions: r.deletions.map(toDeletion),
    stores: r.stores.map(toVerification),
    issuedAt: new Date(r.issuedAt),
    digest: r.digest,
  });

const toRequest = (r: Row): ErasureRequest =>
  Object.freeze({
    id: r.id,
    tenantId: r.tenant_id as TenantId,
    bankId: r.bank_id as BankId,
    subjectId: r.subject_id as SubjectId,
    requestedBy: r.requested_by as PrincipalId,
    requestedAt: r.requested_at,
    state: r.state,
    inventory: r.inventory.map(toInventory),
    deletions: r.deletions.map(toDeletion),
    verifications: r.verifications.map(toVerification),
    ...(r.receipt !== null ? { receipt: toReceipt(r.receipt) } : {}),
    ...(r.failure !== null ? { failure: r.failure } : {}),
    updatedAt: r.updated_at,
  });

/**
 * Persists the ErasureRequest aggregate. State changes come from the domain functions; this
 * class only writes what it is given. The partial unique index (migration 0004) turns a second
 * in-flight request for the same bank into ErasureInFlightError.
 */
export class PgErasureRequestRepository implements ErasureRequestRepository {
  constructor(private readonly db: Queryable) {}

  async create(r: ErasureRequest): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO governance.erasure_requests
           (id, tenant_id, bank_id, subject_id, requested_by, requested_at, state, inventory, deletions, verifications, receipt, failure, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())`,
        [r.id, r.tenantId, r.bankId, r.subjectId, r.requestedBy, r.requestedAt, r.state, ...jsonColumns(r)],
      );
    } catch (e) {
      if (isUniqueViolation(e) && (e as { constraint?: string }).constraint === "erasure_requests_in_flight_idx") throw new ErasureInFlightError(r.bankId);
      throw e;
    }
  }

  /** Compare-and-set on terminality: a row an operator abandoned (or that already receipted) is never overwritten by a late workflow step. */
  async save(r: ErasureRequest): Promise<void> {
    const res = await this.db.query(
      `UPDATE governance.erasure_requests
       SET state = $2, inventory = $3, deletions = $4, verifications = $5, receipt = $6, failure = $7, updated_at = now()
       WHERE id = $1 AND state NOT IN ('receipted', 'failed')`,
      [r.id, r.state, ...jsonColumns(r)],
    );
    if (res.rowCount === 0) {
      const exists = await this.db.query("SELECT 1 FROM governance.erasure_requests WHERE id = $1", [r.id]);
      if ((exists.rowCount ?? 0) > 0) throw new ErasureNotInFlightError(r.id);
      throw new Error(`ErasureRequest ${r.id} not found`);
    }
  }

  async get(id: string, within?: { readonly bankId: BankId; readonly tenantId: TenantId }): Promise<ErasureRequest | undefined> {
    const { rows } = within
      ? await this.db.query<Row>("SELECT * FROM governance.erasure_requests WHERE id = $1 AND bank_id = $2 AND tenant_id = $3", [id, within.bankId, within.tenantId])
      : await this.db.query<Row>("SELECT * FROM governance.erasure_requests WHERE id = $1", [id]);
    return rows[0] ? toRequest(rows[0]) : undefined;
  }

}

/** One transaction per `run`: the request repository and the audit log share the client, so a request write and its audit entry are atomic. */
export class PgErasureUnitOfWork implements ErasureUnitOfWork {
  constructor(private readonly pool: pg.Pool) {}

  run<T>(work: (tx: ErasureTransaction) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, (client) => work({ requests: new PgErasureRequestRepository(client), audit: PgAuditLog.onClient(client) }));
  }
}

const jsonColumns = (r: ErasureRequest): readonly (string | null)[] => [
  JSON.stringify(r.inventory),
  JSON.stringify(r.deletions),
  JSON.stringify(r.verifications),
  r.receipt ? JSON.stringify(r.receipt) : null,
  r.failure ?? null,
];

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
