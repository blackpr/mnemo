import { createHash, randomUUID } from "node:crypto";
import type { BankId, Clock, Result, Scope } from "../../shared-kernel/index.js";
import { err, ok } from "../../shared-kernel/index.js";
import type { AccessDenied, AccessPolicy, AuditLogStore } from "../../governance/index.js";
import type { BankRepository, FactRepository } from "../../memory/index.js";
import { BANK_EXPORT_SCHEMA, buildBankExport } from "../domain/bank-export.js";
import { contentTypeOf, renderClaudePaste, renderGeminiPaste, renderJsonl, renderMarkdown, type ExportFormat } from "../domain/render.js";
import type { ExportStore } from "../ports/export-store.js";

export type ExportBankError = AccessDenied | { readonly kind: "BankNotFound" };

export interface ExportBankInput {
  readonly bankId: BankId;
  readonly format: ExportFormat;
}

export interface ExportBankOutput {
  readonly exportId: string;
  readonly format: ExportFormat;
  readonly contentType: string;
  readonly content: string;
  readonly factCount: number;
  readonly tombstoneCount: number;
  readonly producedAt: Date;
}

/**
 * Produce a bank export in one of the supported formats. A read, so it needs the read
 * capability; like every read it is audited (ids, counts and a digest; never content), and
 * additionally recorded in `portability.exports` so the question "what left this bank, when,
 * taken by whom" has an answer. The paste formats are exports too: they leave the system.
 * The audit entry is written before the ledger row (governance rule: audit before the action);
 * the two are separate transactions, so a failure in between over-reports in the audit log,
 * never under-reports, and the caller gets an error without content either way.
 */
export class ExportBankHandler {
  constructor(
    private readonly banks: BankRepository,
    private readonly facts: FactRepository,
    private readonly access: AccessPolicy,
    private readonly exports: ExportStore,
    private readonly audit: AuditLogStore,
    private readonly clock: Clock,
  ) {}

  async handle(scope: Scope, input: ExportBankInput): Promise<Result<ExportBankOutput, ExportBankError>> {
    const allowed = this.access.canRead(scope, input.bankId);
    if (!allowed.ok) return allowed;
    const bank = await this.banks.get(input.bankId);
    if (!bank) return err({ kind: "BankNotFound" } as const);
    if (bank.tenantId !== scope.tenantId) return err({ kind: "AccessDenied", bankId: input.bankId, required: "read" } as const);

    const producedAt = this.clock.now();
    const facts = await this.facts.listAll(scope);
    const bankExport = buildBankExport({ bankId: bank.id, subjectId: bank.subjectId, facts, exportedAt: producedAt });
    const content = render(input.format, { bankExport, facts, at: producedAt });
    const exportId = randomUUID();
    const bytes = Buffer.byteLength(content, "utf8");
    const contentSha256 = createHash("sha256").update(content, "utf8").digest("hex");
    const { facts: factCount, tombstones: tombstoneCount } = bankExport.header.counts;

    await this.audit.append({
      tenantId: scope.tenantId,
      bankId: bank.id,
      principalId: scope.principalId,
      action: "export.produced",
      details: { exportId, format: input.format, facts: factCount, tombstones: tombstoneCount, bytes, sha256: contentSha256 },
      at: producedAt,
    });
    await this.exports.record({
      id: exportId,
      tenantId: scope.tenantId,
      bankId: bank.id,
      principalId: scope.principalId,
      format: input.format,
      schemaVersion: BANK_EXPORT_SCHEMA,
      factCount,
      tombstoneCount,
      bytes,
      contentSha256,
      producedAt,
    });
    return ok({ exportId, format: input.format, contentType: contentTypeOf(input.format), content, factCount, tombstoneCount, producedAt });
  }
}

function render(format: ExportFormat, ctx: { bankExport: ReturnType<typeof buildBankExport>; facts: Parameters<typeof renderClaudePaste>[0]; at: Date }): string {
  switch (format) {
    case "jsonl":
      return renderJsonl(ctx.bankExport);
    case "markdown":
      return renderMarkdown(ctx.bankExport);
    case "claude-paste":
      return renderClaudePaste(ctx.facts, ctx.at);
    case "gemini-paste":
      return renderGeminiPaste(ctx.facts, ctx.at);
  }
}
