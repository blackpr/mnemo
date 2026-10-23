# Retrieval adapters

Each adapter implements `RetrievalEngine` and must pass the shared contract in
`test/retrieval/retrieval-engine.contract.ts`:

- indexes a fact, recalls it by a paraphrase
- stops returning a fact after `retractFact`
- respects `asOf` for point-in-time recall
- never returns hits from another bank under a scope bound to this one
- `purgeBank` returns `remaining: 0`, `countBank` reports the rows before and zero after, and a follow-up recall returns nothing
- `rebuild` restores recall after the engine's storage is wiped

Planned adapters:

| Adapter | Spike arm | Notes |
|---|---|---|
| `pgvector/pgvector-engine.ts` | B | **Implemented.** Table `retrieval.pgvector_index` in our own Postgres, cosine distance, embedder id recorded per row. Embedding column has no fixed dimension yet; once the embedder is chosen a migration sets `vector(N)` and adds an HNSW index. |
| `hashing-embedder.ts` | B (tests/dev) | **Implemented.** Deterministic bag-of-words `Embedder` for contract tests and offline dev (`EMBEDDER=hashing`). |
| `ai-sdk-embedder.ts` | B | **Implemented.** Production `Embedder` over the Vercel AI SDK: OpenAI, Google, OpenAI-compatible (`EMBEDDER=provider:model`, optional `EMBEDDING_DIMENSIONS`). The embedder id is stored per row; recall filters on it, so a switch needs `admin reindex --bank`. |
| `hindsight-engine.ts` | C | Maps Bank to a Hindsight bank; anti-corruption layer around its REST API; records their memory ids against our fact ids for retraction and purge. |
| `honcho-engine.ts` | D | Maps Bank to a Honcho workspace + peer; same pattern. Honcho runs extraction itself: for the spike we feed it Episodes and let the adapter translate its derived "representations" to hits on our Episode ids. |

Nothing in this folder may be imported by `domain/` or `application/` code anywhere.
