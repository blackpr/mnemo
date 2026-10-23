import type { BankId, PrincipalId, Scope, TenantId } from "../../shared-kernel/index.js";
import type { ExportFormat } from "../domain/render.js";

/** What we keep about every export: who took what out, when, and a digest of it. Never the content. */
export interface ExportRecordRow {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly bankId: BankId;
  readonly principalId: PrincipalId;
  readonly format: ExportFormat;
  readonly schemaVersion: string;
  readonly factCount: number;
  readonly tombstoneCount: number;
  readonly bytes: number;
  readonly contentSha256: string;
  readonly producedAt: Date;
}

export interface ExportStore {
  record(row: ExportRecordRow): Promise<void>;
  /** Scoped like every other read: filtered by the scope's bank and tenant in the adapter. */
  listByBank(scope: Scope, opts?: { readonly limit?: number }): Promise<readonly ExportRecordRow[]>;
}
