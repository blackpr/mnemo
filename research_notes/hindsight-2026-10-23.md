# Hindsight (vectorize-io/hindsight), re-read for spike stage 2 on 2026-10-23

Sources: the live OpenAPI spec (https://hindsight.vectorize.io/openapi.json, `info.version` 1.1.0),
the docs (https://hindsight.vectorize.io/developer/...), the GitHub releases page, GHCR tags, npm,
and the TypeScript client source. Then the container itself (`npm run engines:hindsight:up`) for
everything the docs leave open.

## What changed since the research report (`Self hosted AI memory layer landscape.md`)

- Nothing newer than **v1.1.0 (2026-10-21)**; `main` has commits from 2026-10-23 that are not released.
  The report's version and license (MIT) hold. PyPI shows an "Apache 2.0" classifier beside an MIT
  license expression; the repository LICENSE is MIT.
- The README's `cd docker/docker-compose && docker compose up` is stale: compose files live in
  subdirectories (`docker/docker-compose/external-pg/`). The single image
  `ghcr.io/vectorize-io/hindsight:1.1.0` bundles API (8888), control-plane UI (9999) and an embedded
  Postgres ("pg0", dev only); it is 3.7 GB on arm64. There is no `v1.1.0` tag, only `1.1.0`.
- v1.1.0 notes worth knowing: bank ids with a leading `_` are reserved; `ALTER` of `memory_units`
  at startup; Anthropic refusal handling fixed; per-call "server-side LLM selection".
- **Server auth is off by default.** Our compose turns it on
  (`HINDSIGHT_API_TENANT_EXTENSION=...ApiKeyTenantExtension`, `HINDSIGHT_API_TENANT_API_KEY`); the
  MCP endpoint `/mcp/{bank_id}/` is open unless that is set.
- Official TypeScript client: `@vectorize-io/hindsight-client` 1.1.0 (MIT, zero runtime deps,
  published with the server release). High-level methods cover retain/recall/list/banks; the
  generated layer (`sdk.*`) covers the rest (`deleteDocument`, `updateMemory`, `getAgentStats` is
  the bank stats call, `listLlmRequests`, `deleteBank`, `listBanks`).

## Facts that decided the adapter (`src/retrieval/infrastructure/hindsight/hindsight-engine.ts`)

| Need of the port | What Hindsight offers | Mapping |
|---|---|---|
| Index a fact we already extracted | Retain always runs the bank's extraction mode. `retain_extraction_mode: verbatim` stores the text as-is, but still makes one LLM call per item (entities, dates: 2.6k input tokens, 2.5k of them prompt-cached, about 130 output, measured). Disabling the graph and temporal retrieval arms does not remove it. | Verbatim bank, observations off. **No LLM-free write path**; the contract test spends a few cents. |
| Our ids on hits | `metadata` (string to string) and `document_id` are stored and returned on every recall result and list item. | `document_id = fact:<id>` / `episode:<id>`, metadata `refId`, `kind`, `validFrom`, `validTo`, `retracted`. |
| Retract a fact | No `DELETE` for one memory. `PATCH .../memories/{id} {state: invalidated}` soft-retires it and recall excludes it (verified). Hard delete exists per document. | `retractFact` lists the document's units and invalidates them. The port gives no bank id, so every bank with our prefix is scanned (`listBanks?q=prefix`). |
| Re-index with new validity (supersession) | A re-retain of identical text under the same `document_id` is skipped by content hash even with `update_mode: replace`, and the replace first drops the document's units (measured: usage 0, document left with 0 units), so re-retaining an unchanged document loses it. | One document per version, `fact:<id>:<hash of metadata>`: a version that already exists is never retained again (redelivery is safe), a new version is retained first and older versions deleted after, recall keeps the newest (`indexedAt`). A failed retain leaves the old version recallable for the outbox retry. The skip-if-present step was added after the last live contract run and still needs `npm run test:engines` once the API account has credit. |
| Point-in-time (`asOf`) | None. `temporal_window` ranks, it does not filter; `query_timestamp` anchors relative dates. Memories carry `occurred_start/end` and `mentioned_at`, no validity interval. | Recall over-fetches (token budget 8k, 16k with `asOf`) and filters by our validity metadata here; a bank with hundreds of live facts and a distant `asOf` can still starve, which pgvector cannot. `queryTimestamp` is passed through. |
| Result limit | None: recall is bounded by `max_tokens` and `budget`. | Filter and slice to `limit`. |
| Count a bank | `GET .../memories/list?limit=1` returns `total`; `stats` has `total_nodes`, `total_documents`. | `countBank` = list total; 404 = 0. |
| Purge with proof of zero | `DELETE /v1/default/banks/{id}` returns "Bank ... and all associated data deleted successfully" (`deleted_count` counts units, documents, links). Afterwards list, stats and `llm-requests` 404. **Checked in Hindsight's embedded Postgres** (psql inside the container): for deleted banks `memory_units`, `invalidated_memory_units`, `documents`, `chunks`, `entities`, `async_operations`, `audit_log` and `banks` hold zero rows, but **`llm_requests` keeps every trace row (55 for the test banks), including the full extraction prompts with the subject's text**, until its retention expires (default 1 day; our compose first set it to forever for arm C's accounting and now leaves the default). | `purgeBank` = count, delete bank, count again. Zero is what the API reports for memories; the trace is a deletion gap the receipt cannot see. Disable the trace (`HINDSIGHT_API_LLM_TRACE_ENABLED=false`) wherever the receipt must mean everything. |
| Embedder id filter | Hindsight owns its embedder (`HINDSIGHT_API_EMBEDDINGS_*`); a change "loses data" per its docs. | Not expressible; rebuild the bank after an embedder change. |
| Isolation | Banks "isolated with no cross-bank leakage"; one API key for the whole server (tenant extension point exists). | Contract test "never returns hits from another bank" passes; scoped-read probe per bank not possible with one key. |

Write-token accounting for arm C: synchronous retain returns `usage`; the per-call trace
(`GET .../llm-requests`, read right after ingestion within Hindsight's default 1-day retention) also covers the
background consolidation into observations, and splits `call_type` llm / embedding, so the arm
records both and the table uses the trace total.

## Ops notes

- First start pulls 3.7 GB; boot to healthy took under a minute here. `shm_size: 1g` as the docs ask.
- Bank ids: ours (`mem-bank-a`, `eval-bbd0145d`) are accepted.
- The adapter passes a 60 s `AbortSignal` on every call (the client has no timeout of its own), so a hung engine fails the outbox event instead of blocking the relay.
- `verbatim` keeps prompt caching warm (2.5k of 2.6k input tokens cached per item).
- Consolidation into observations runs in the background after a synchronous retain; "bank
  finished" is `stats.pending_operations == 0 && pending_consolidation == 0`.
