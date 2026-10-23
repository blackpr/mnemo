# Status and handoff

Last updated 2026-10-23. Read this first when resuming work. `ARCHITECTURE.md` is the design; this file is where things stand.

## What exists (all committed, 131 tests passing on `npm test`)

| Area | State |
|---|---|
| Memory domain | Bank, Episode (append-only), bi-temporal Fact (supersession closes validity and links; invalidation retracts), WritePolicy (contradiction before dedupe), ConflictResolver |
| Governance | API keys (sha256), ScopeResolver (tenant boundary enforced once), per-tenant hash-chained audit log, fail-closed ErasureRequest state machine (domain only; no persistence yet) |
| Persistence | Postgres, one schema per context, plain-SQL migrations under advisory lock, outbox relay with per-event savepoints, backoff, dead-letter |
| Retrieval | pgvector engine filtered by embedder id; `AiSdkEmbedder` (OpenAI/Google) configured by `EMBEDDER`; `HashingEmbedder` for tests; `admin reindex` |
| Extraction | `LlmExtractor` (Vercel AI SDK, any provider), claim-based worker loop separate from indexing, idempotent per trigger episode, cost ledger in `extraction.runs`, code guards (Subject-authored source, secret detection) |
| Attachments | REST (`/v1/banks/:bankId/...`) and MCP (`/v1/banks/:bankId/mcp`, stateless Streamable HTTP) over the same handlers and audit |
| Portability | `BankExport` v1 (JSONL with tombstones, deterministic Markdown by topic, JSON Schema `src/portability/schema/bank-export.v1.json`), export ledger `portability.exports` + `export.produced` audit, REST `GET /v1/banks/:bankId/export?format=jsonl\|markdown`; Claude Code memory-dir importer (gray-matter, idempotent via path+digest externalRef, episodes only); Claude/Gemini paste renderers. See `src/portability/README.md` |
| Tooling | `admin` CLI (banks, principals, grants, keys, extractor, reindex, queues, `export`, `import-claude-code`, `render-import`), `eval/demo-extraction.sh`, `docker-compose.yml` (dev DB `mem`, test DB `mem_test`) |

Verified live on 2026-10-23: Claude Opus 5.5 extraction, OpenAI `text-embedding-3-small` recall, Claude Code connected over MCP (`claude mcp list` shows `mem ✔ Connected`), a retain over MCP extracted into a fact. Also on 2026-10-23: all three portability admin commands and the REST export against `bank-demo`; four real memory files from `~/.claude/projects/-Users-blackpr-code-local-vector-search/memory` imported and extracted into facts (bank-demo now holds those too).

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
- Governance: erasure persistence and the erase workflow (purge across facts, episodes, index, receipt) not built; erasure must also purge `portability.exports` rows for the bank.
- Portability: export ledger row and audit entry are two transactions (audit first, so a failure between them over-reports); symlinked memory files are skipped by the reader (`isFile()` is false); no MCP `export` tool yet (README lists it); the other import adapters (claude.ai export, Gemini Takeout, ChatGPT ZIP) are not built; id generation lives in the application layer rather than the attachment, unlike Memory.

## Suggested next steps, in order

1. Erasure end to end: persist `ErasureRequest`, purge across stores with `mem.erasure` session flag, verify, receipt into the audit chain; admin command.
2. The spike (`spike-plan-hindsight-vs-honcho.md`): wire the four arms into promptfoo through REST; Hindsight and Honcho adapters must pass `test/retrieval/retrieval-engine.contract.ts`.
3. Hardening: HNSW index migration, erasure of API keys, rate limits on attachments.
