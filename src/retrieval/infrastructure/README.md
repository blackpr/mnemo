# Retrieval adapters

Each adapter implements `RetrievalEngine` and must pass the shared contract in
`test/retrieval/retrieval-engine.contract.ts`:

- indexes a fact, recalls it by a paraphrase
- stops returning a fact after `retractFact`
- respects `asOf` for point-in-time recall
- never returns hits from another bank under a scope bound to this one
- `purgeBank` returns `remaining: 0`, `countBank` reports the rows before and zero after, and a follow-up recall returns nothing
- `rebuild` restores recall after the engine's storage is wiped

Adapters:

| Adapter | Spike arm | Notes |
|---|---|---|
| `pgvector/pgvector-engine.ts` | B | **Implemented.** Table `retrieval.pgvector_index` in our own Postgres, cosine distance, embedder id recorded per row. The embedding column starts untyped; `admin pin-dimensions` (`pin-dimensions.ts`) types it to `vector(EMBEDDING_DIMENSIONS)`, builds the cosine HNSW index, deletes rows of other embedders and records the pin in `retrieval.settings`; the server refuses to boot on a width mismatch. |
| `hashing-embedder.ts` | B (tests/dev) | **Implemented.** Deterministic bag-of-words `Embedder` for contract tests and offline dev (`EMBEDDER=hashing`). |
| `ai-sdk-embedder.ts` | B | **Implemented.** Production `Embedder` over the Vercel AI SDK: OpenAI, Google, OpenAI-compatible (`EMBEDDER=provider:model`, optional `EMBEDDING_DIMENSIONS`). The embedder id is stored per row; recall filters on it, so a switch needs `admin reindex --bank`. |
| `hindsight/hindsight-engine.ts` | C | **Implemented** (2026-10-23) over the official `@vectorize-io/hindsight-client`. Bank -> Hindsight bank `<ENGINE_NAMESPACE><bankId>` in `verbatim` extraction mode; our ids and validity travel in `metadata` / `document_id` and come back on recall; `retractFact` soft-invalidates (no single-memory delete); `asOf` is filtered here (Hindsight has no as-of); `purgeBank` deletes the bank and re-counts via the API. Verbatim retain still costs one small LLM call per item. Gaps and measurements: `research_notes/hindsight-2026-10-23.md`. |
| `honcho/honcho-engine.ts` | D | **Implemented** (2026-10-23) over the official `@honcho-ai/sdk`. Bank -> workspace with peer `subject` and sessions `facts` / `episodes`, all `observe_me: false` (the deriver does not re-extract our facts); a fact or episode is a message whose metadata carries our id and validity; search (semantic + keyword, RRF) gives the order, `1/rank` is the score; retraction, validFrom and the facts session are pushed into Honcho's search filters, `validTo` is filtered here; `purgeBank` deletes sessions and workspace and polls Honcho's asynchronous deletion to zero. Needs the shared Redis cache on (see the stale-cache finding in `research_notes/honcho-2026-10-23.md`). |
| `engine-from-env.ts` | all | `ENGINE=pgvector|hindsight|honcho` selects the adapter for the server and the admin CLI (`HINDSIGHT_BASE_URL` / `HINDSIGHT_API_KEY`, `HONCHO_BASE_URL` / `HONCHO_API_KEY`, optional `ENGINE_NAMESPACE`). |

Both external adapters pass the contract against their containers: `npm run engines:up`, then
`npm run test:engines` (RUN_ENGINE_TESTS=1; skipped by `npm test`, which stays free of Docker beyond
Postgres and of network). Neither can express the embedder-id filter (each engine owns its embedder)
nor inspect the engine's own database for the erasure proof: "zero" is what the engine's API reports.

Nothing in this folder may be imported by `domain/` or `application/` code anywhere.
