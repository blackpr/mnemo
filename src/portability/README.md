# Portability (supporting subdomain)

Makes the Bank the system of record for memory across providers. Layout follows the other
contexts: `domain/` (pure: export model, renderers, imported-document mapping), `ports/`
(`ExportStore`), `application/` (`ExportBankHandler`, `ImportDocumentsHandler`),
`infrastructure/` (Postgres export ledger, Claude Code directory reader), `schema/`.

## Export

- `BankExport` v1 (`domain/bank-export.ts`): every fact in the bank, once. Still-believed facts
  (current or closed by supersession) are `fact` records; retracted facts are `tombstone`
  records that keep their content plus the invalidation (retraction is a change of belief, not
  erasure). Each record carries validity (world time), transaction time, full provenance and the
  supersession links. Records are totally ordered (validFrom, recordedAt, id), and nested
  objects are rebuilt in schema order, so two exports of the same state differ only in the
  header's `exportedAt`.
- Formats (`domain/render.ts`): `jsonl` (header line, then one record per line; the wire shape
  is fixed by `schema/bank-export.v1.json`, validated in tests with ajv), `markdown`
  (grouped by topic, "General" last, retracted facts in their own section), and the provider
  paste formats below. The topic is the humanized structured predicate ("prefers_editor" ->
  "Prefers editor"); facts without a predicate are "General".
- Every export, paste formats included, is recorded in `portability.exports` (who, when, format,
  counts, byte size, sha256 of the content; never the content) and audited as `export.produced`.
  Needs the `read` capability.
- Surfaces: `GET /v1/banks/:bankId/export?format=jsonl|markdown` (REST) and
  `npm run admin -- export --bank <id> --out <path> [--format jsonl|markdown]`.

## Import adapters

All imports create **Episodes** (`kind: imported_document`) with `source` provenance through
Memory's own retain command, so they are audited and published to the outbox like any turn.
They never create Facts; extraction runs as usual (imported documents count as
Subject-authored for the extractor's source guard).

| Adapter | Input | Status |
|---|---|---|
| `claude-code-memory` | `~/.claude/projects/<project>/memory/*.md` (frontmatter + body), `MEMORY.md` index, the `CLAUDE.md` / `CLAUDE.local.md` hierarchy of a repository | **implemented**: `npm run admin -- import-claude-code --bank <id> --dir <path>` |
| `claude-chat-export` | claude.ai data export | later |
| `gemini-takeout` | Google Takeout chat export | later |
| `chatgpt-export` | ChatGPT data export ZIP | later |

The Claude Code reader (`infrastructure/claude-code/memory-dir-reader.ts`) walks `--dir`
recursively (skipping `node_modules`, `.git`, `dist`) and takes only `MEMORY.md`, `CLAUDE.md`,
`CLAUDE.local.md`, and `*.md` directly inside a `memory/` directory that is either the given
root or at `projects/<project>/memory` (a repository's own `src/memory/README.md` is not
memory); other Markdown is ignored on purpose. Frontmatter is parsed with gray-matter restricted
to YAML and JSON (its default `javascript` engine would eval `---js` blocks); a file whose
frontmatter does not parse is imported whole. The Episode keeps the raw file text verbatim; `occurredAt` is frontmatter
`modified` (top level or under `metadata`, where Claude Code puts it) or else the file's mtime.
`externalRef` is `claude-code-memory:<absolute path>@<sha256 prefix of the content>`: re-importing
an unchanged file is skipped (duplicate externalRef), an edited file becomes a new Episode so the
extractor sees the change and supersedes what the old version established.

## Render into provider import formats

`npm run admin -- render-import --bank <id> --target claude|gemini [--out <path>]` renders the
facts current now: for Claude (Settings > Memory > Import) one block of `[date] - memory content`
lines grouped by category; for Gemini a plain preferences summary, one statement per line. Both
are exports (recorded and audited) so provider memory can be re-seeded from our store at any time.
