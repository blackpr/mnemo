# Retrieval adapters

Each adapter implements `RetrievalEngine` and must pass the shared contract test in
`test/retrieval/retrieval-engine.contract.ts` (to be written with the first adapter):

- indexes a fact, recalls it by a paraphrase
- stops returning a fact after `retractFact`
- respects `asOf` for point-in-time recall
- never returns hits from another bank under a scope bound to this one
- `purgeSubject` returns `remaining: 0` and a follow-up recall returns nothing
- `rebuild` restores recall after the engine's storage is wiped

Planned adapters:

| Adapter | Spike arm | Notes |
|---|---|---|
| `pgvector-engine.ts` | B | Table `retrieval.pgvector_index` in our own Postgres. Default engine. |
| `hindsight-engine.ts` | C | Maps Bank to a Hindsight bank; anti-corruption layer around its REST API; records their memory ids against our fact ids for retraction and purge. |
| `honcho-engine.ts` | D | Maps Bank to a Honcho workspace + peer; same pattern. Honcho runs extraction itself: for the spike we feed it Episodes and let the adapter translate its derived "representations" to hits on our Episode ids. |

Nothing in this folder may be imported by `domain/` or `application/` code anywhere.
