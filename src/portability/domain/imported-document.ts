import { createHash } from "node:crypto";
import type { BankId, EpisodeId } from "../../shared-kernel/index.js";
import type { NewEpisode } from "../../memory/index.js";

export type ImportedDocumentKind = "memory" | "index" | "claude-md";

/** A file an import adapter read. `raw` is the complete original text: the Episode keeps it verbatim (non-lossy provenance). */
export interface ImportedDocument {
  readonly path: string;
  readonly kind: ImportedDocumentKind;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly raw: string;
  /** From frontmatter `modified` (or `metadata.modified`) when present, else the file's mtime. */
  readonly modifiedAt: Date;
}

export const CLAUDE_CODE_MEMORY_SOURCE = "claude-code-memory";

/**
 * Idempotency key: the path identifies the document, the content hash its version. Re-importing
 * an unchanged file is a duplicate (skipped); an edited file becomes a new Episode, so the
 * extractor sees the change and supersedes what the old version established.
 */
export function externalRefFor(doc: Pick<ImportedDocument, "path" | "raw">): string {
  const digest = createHash("sha256").update(doc.raw).digest("hex").slice(0, 16);
  return `${CLAUDE_CODE_MEMORY_SOURCE}:${doc.path}@${digest}`;
}

export function toNewEpisode(doc: ImportedDocument, bankId: BankId, id: EpisodeId): NewEpisode {
  return {
    id,
    bankId,
    kind: "imported_document",
    source: CLAUDE_CODE_MEMORY_SOURCE,
    text: doc.raw,
    occurredAt: doc.modifiedAt,
    externalRef: externalRefFor(doc),
  };
}
