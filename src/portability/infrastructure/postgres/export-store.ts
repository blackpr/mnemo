import type { BankId, PrincipalId, Scope, TenantId } from "../../../shared-kernel/index.js";
import type { Queryable } from "../../../platform/postgres/pool.js";
import type { ExportFormat } from "../../domain/render.js";
import type { ExportRecordRow, ExportStore } from "../../ports/export-store.js";

interface Row {
  id: string;
  tenant_id: string;
  bank_id: string;
  principal_id: string;
  format: ExportFormat;
  schema_version: string;
  fact_count: number;
  tombstone_count: number;
  bytes: string;
  content_sha256: string;
  produced_at: Date;
}

const toRow = (r: Row): ExportRecordRow =>
  Object.freeze({
    id: r.id,
    tenantId: r.tenant_id as TenantId,
    bankId: r.bank_id as BankId,
    principalId: r.principal_id as PrincipalId,
    format: r.format,
    schemaVersion: r.schema_version,
    factCount: r.fact_count,
    tombstoneCount: r.tombstone_count,
    bytes: Number(r.bytes),
    contentSha256: r.content_sha256,
    producedAt: r.produced_at,
  });

export class PgExportStore implements ExportStore {
  constructor(private readonly db: Queryable) {}

  async record(row: ExportRecordRow): Promise<void> {
    await this.db.query(
      `INSERT INTO portability.exports
         (id, tenant_id, bank_id, principal_id, format, schema_version, fact_count, tombstone_count, bytes, content_sha256, produced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [row.id, row.tenantId, row.bankId, row.principalId, row.format, row.schemaVersion, row.factCount, row.tombstoneCount, row.bytes, row.contentSha256, row.producedAt],
    );
  }

  async listByBank(scope: Scope, opts: { readonly limit?: number } = {}): Promise<readonly ExportRecordRow[]> {
    const { rows } = await this.db.query<Row>("SELECT * FROM portability.exports WHERE bank_id = $1 AND tenant_id = $2 ORDER BY produced_at DESC, id DESC LIMIT $3", [scope.bankId, scope.tenantId, opts.limit ?? 100]);
    return rows.map(toRow);
  }
}
