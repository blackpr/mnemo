# Status and handoff

Last updated 2026-10-23. Read this first when resuming work. `ARCHITECTURE.md` is the design; this file is where things stand.

## What exists (all committed, 142 tests passing on `npm test`)

| Area | State |
|---|---|
| Memory domain | Bank, Episode (append-only), bi-temporal Fact (supersession closes validity and links; invalidation retracts), WritePolicy (contradiction before dedupe), ConflictResolver |
| Governance | API keys (sha256), ScopeResolver (tenant boundary enforced once), per-tenant hash-chained audit log, fail-closed ErasureRequest state machine, and the Erasure workflow: `EraseBank` (request row and `erasure.requested` audit entry in one transaction before any deletion, bank frozen under a row lock so in-flight writers finish first, per-store inventory / purge / re-count via the `ErasableStore` port, receipt over tenant, bank, subject, per-store deletions and zero counts with its digest chained into the audit log, `failed` with per-store deletions on any error; the audit log gets error kinds only, never error text), `governance.erasure_requests` (one in-flight per bank by partial unique index), REST `POST/GET /v1/banks/:bankId/erasure` (erase capability; no MCP tool by design), `admin erase-bank --yes` / `erasure-status` / `erasure-abandon` (recovery for a request a crash left in flight; refuses one that changed in the last 10 min unless `--force`, and a terminal row is never overwritten by a late workflow step) |
| Persistence | Postgres, one schema per context, plain-SQL migrations under advisory lock, outbox relay with per-event savepoints, backoff, dead-letter. Erasure is the only DELETE path: Memory purges facts, episodes and outbox rows in one transaction under `SET LOCAL mem.erasure = 'on'` (the append-only triggers refuse it otherwise); the bank row stays as an `erased` tombstone |
| Retrieval | pgvector engine filtered by embedder id; `countBank` / `purgeBank` on the port (contract-tested, so Hindsight/Honcho adapters must prove erasure too); `AiSdkEmbedder` (OpenAI/Google) configured by `EMBEDDER`; `HashingEmbedder` for tests; `admin reindex` |
| Extraction | `LlmExtractor` (Vercel AI SDK, any provider), claim-based worker loop separate from indexing, idempotent per trigger episode, cost ledger in `extraction.runs`, code guards (Subject-authored source, secret detection) |
| Attachments | REST (`/v1/banks/:bankId/...`) and MCP (`/v1/banks/:bankId/mcp`, stateless Streamable HTTP) over the same handlers and audit |
| Portability | `BankExport` v1 (JSONL with tombstones, deterministic Markdown by topic, JSON Schema `src/portability/schema/bank-export.v1.json`), export ledger `portability.exports` + `export.produced` audit, REST `GET /v1/banks/:bankId/export?format=jsonl\|markdown`; Claude Code memory-dir importer (gray-matter, idempotent via path+digest externalRef, episodes only); Claude/Gemini paste renderers. See `src/portability/README.md` |
| Tooling | `admin` CLI (banks, principals, grants, keys, extractor, reindex, queues, `export`, `import-claude-code`, `render-import`, `erase-bank`, `erasure-status`, `erasure-abandon`), `eval/demo-extraction.sh`, `docker-compose.yml` (dev DB `mem`, test DB `mem_test`) |

Verified live on 2026-10-23: Claude Opus 5.5 extraction, OpenAI `text-embedding-3-small` recall, Claude Code connected over MCP (`claude mcp list` shows `mem ✔ Connected`), a retain over MCP extracted into a fact. Also on 2026-10-23: all three portability admin commands and the REST export against `bank-demo`; four real memory files from `~/.claude/projects/-Users-blackpr-code-local-vector-search/memory` imported and extracted into facts (bank-demo now holds those too). Erasure verified live on 2026-10-23 against a throwaway bank `bank-erase-check` (tenant `t-erase`, now an `erased` tombstone): retain, recall, `POST /erasure` to a receipt, `GET /erasure/:id`, empty recall and `409 bank_not_writable` afterwards, `admin erasure-status`, and a second `admin erase-bank` re-proving zero. bank-demo untouched (30 facts).

## Running it

```bash
npm run db:up && npm run db:migrate
npm start                      # REST + MCP on :8787, relay loop, extraction worker; loads .env
npm run admin -- <command>     # see src/cli/admin.ts header for the bootstrap sequence
./eval/demo-extraction.sh      # needs a running server and .demo-key
npm test                       # unit + Postgres suites on mem_test; npm run test:live adds paid provider tests
```

`.env` (gitignored) holds `DATABASE_URL`, `TEST_DATABASE_URL`, provider keys, `EMBEDDER`. `.demo-key` (gitignored) holds the demo bank's API key. Claude Code is registered at user scope against `bank-demo`; re-run `claude mcp add` (see `src/attachment/README.md`) for a real bank.

## Pitfalls learned

- Tests TRUNCATE; they must only ever use `TEST_DATABASE_URL` (`mem_test`). This bit us once.
- The server keeps the embedder it booted with. After changing `EMBEDDER`, run `admin reindex --bank <id>` and restart.
- `npm test` with keys in `.env` would spend money; paid tests are gated behind `RUN_LIVE_TESTS=1`.
- The nested `claude -p` CLI on this machine has an expired OAuth session; use the MCP SDK client or the interactive app to exercise tools.
- `preview_start` in the desktop app looked for `launch.json` in the old scratch folder; the server is run with `npm start` in the background instead. The server does not reload code: after changing attachment code, kill the `npm start` process and start it again.
- gray-matter's default engine table evals `---js` frontmatter; the Claude Code reader passes an options object that replaces the javascript/coffee engines with throwing parsers. Keep it that way for any future Markdown importer.
- Postgres jsonb does not preserve key order; exports rebuild nested objects key by key so output is byte-stable.
- `DuplicateEpisodeError` carries the attempted (new) id, not the existing episode's id; importers can only report the externalRef of a skipped document.
- zsh expands `=word` on the command line; do not use `====` as an echo separator in shell commands.
- `governance.erasure_requests` was created in migration 0001; 0004 only adds columns and the in-flight index. The receipt digest is over canonical JSON (sorted keys) for the same jsonb key-order reason as the audit hash; `verifyReceipt` recomputes it.
- Erasure is synchronous on the request path (fine at current bank sizes). A store adapter must return the same store names from `count` and `purge`; a name that appears in the inventory but not in the re-count fails the request closed.
- Any new store that holds Subject data (an engine adapter, a cache) must be added to the `erasure.stores` list in `src/attachment/rest/main.ts`, `src/cli/admin.ts` and `test/helpers/erasure.ts`, or erasure cannot prove it empty.

## Working agreements (from the user)

- Battle-tested, active libraries over hand-rolled code; check the installed API in `node_modules` before writing against it.
- Every commit gets an independent review agent first; at most 2 (exceptionally 3) rounds, then commit and list what was left.
- One repo, one package, no monorepo. Practical DDD: contexts as folders, pure domain, ports and adapters.
- Keep assistant context under about 50 to 60 percent: document (this file plus memory notes), then compact.

## Open follow-ups (low severity, from reviews)

- REST: duplicate `externalRef` 409 reports a fresh id instead of the existing episode's id; admin `grant` silently replaces capabilities; `revoke-key` needs the plaintext key.
- Extraction: config errors (bad provider, missing key) retry 8 times before dead; a zero-fact extraction leaves no idempotency marker (cost only); Google `taskType` hint unused.
- Retrieval: `vector(N)` column and HNSW index deferred until the embedder is pinned (`EMBEDDING_DIMENSIONS`); delete foreign-embedder rows before adding the index.
- MCP: DNS-rebinding protection off (bearer key makes it moot on localhost); no `assert_fact` or erase tool by design.
- Erasure (left after two review rounds): synchronous (a very large bank would hold the HTTP request open; make it a job with the request id as the handle); API keys and grants on an erased bank are not revoked (hardening item); the `erasing` freeze is never lifted on failure, so a bank stays unwritable until a retry succeeds (intended; no unfreeze command); a request left in flight by a crash is only recovered by `erasure-abandon` (no automatic sweep); a retry's receipt does not reference the failed request whose deletions it completes (evidence for one erasure can span two request rows, joined through the audit chain); `PgBankRepository.update` writes status and policy together, so an admin `set-extractor` racing an erasure can be reverted (pre-existing pattern for every bank update); the export status check is not under the bank lock the writers take (a tiny window for a ledger row to land during the freeze; verification would then fail closed and the retry cleans it up); the receipt is verifiable with `verifyReceipt` but no CLI command does it yet.
- Portability: export ledger row and audit entry are two transactions (audit first, so a failure between them over-reports); symlinked memory files are skipped by the reader (`isFile()` is false); no MCP `export` tool yet (README lists it); the other import adapters (claude.ai export, Gemini Takeout, ChatGPT ZIP) are not built; id generation lives in the application layer rather than the attachment, unlike Memory.

## Suggested next steps, in order

1. The spike (`spike-plan-hindsight-vs-honcho.md`): wire the four arms into promptfoo through REST; Hindsight and Honcho adapters must pass `test/retrieval/retrieval-engine.contract.ts` (including the `countBank` / `purgeBank` case).
2. Hardening: HNSW index migration, revoke API keys and grants on erasure, `admin verify-receipt`, rate limits on attachments.
3. Erasure as a background job for large banks (same request record, `202` with the id).
