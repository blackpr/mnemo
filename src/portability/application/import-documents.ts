import { randomUUID } from "node:crypto";
import type { BankId, EpisodeId, Result, Scope } from "../../shared-kernel/index.js";
import { asEpisodeId, err, ok } from "../../shared-kernel/index.js";
import type { RecordEpisodeError, RecordEpisodeHandler } from "../../memory/index.js";
import { externalRefFor, toNewEpisode, type ImportedDocument } from "../domain/imported-document.js";

export interface ImportOutcome {
  readonly imported: readonly { readonly path: string; readonly episodeId: EpisodeId }[];
  /** Already present (same path and content, identified by externalRef): idempotent re-import. */
  readonly skipped: readonly { readonly path: string; readonly externalRef: string }[];
}

export type ImportDocumentsError = Exclude<RecordEpisodeError, { kind: "DuplicateEpisode" }> & { readonly path: string };

/**
 * Turns imported documents into Episodes through Memory's own retain command, so each one is
 * recorded, audited and published to the outbox exactly like a conversation turn; extraction
 * then runs as usual. Imports never create Facts. A duplicate externalRef is the normal
 * outcome of re-running an import and is reported as skipped; any other error stops the
 * import at that document (earlier episodes stay recorded, each in its own transaction).
 */
export class ImportDocumentsHandler {
  constructor(private readonly recordEpisode: RecordEpisodeHandler) {}

  async handle(scope: Scope, bankId: BankId, docs: readonly ImportedDocument[]): Promise<Result<ImportOutcome, ImportDocumentsError>> {
    const imported: { path: string; episodeId: EpisodeId }[] = [];
    const skipped: { path: string; externalRef: string }[] = [];
    for (const doc of docs) {
      const r = await this.recordEpisode.handle(scope, toNewEpisode(doc, bankId, asEpisodeId(randomUUID())));
      if (r.ok) imported.push({ path: doc.path, episodeId: r.value.episodeId });
      else if (r.error.kind === "DuplicateEpisode") skipped.push({ path: doc.path, externalRef: externalRefFor(doc) });
      else return err({ ...r.error, path: doc.path });
    }
    return ok({ imported, skipped });
  }
}
