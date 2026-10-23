# Attachment (generic subdomain)

Protocol adapters only. No domain model. Each translates an external protocol into
application commands and queries from `src/memory` and `src/governance`, and nothing else.

| Folder | Protocol | Status | Reaches |
|---|---|---|---|
| `rest/` | HTTP JSON | **implemented** (`npm start`) | SDKs, eval arm adapters |
| `mcp/` | MCP remote streamable-HTTP with OAuth; tools `recall`, `retain`, `list_facts`, `confirm`, `dispute`, `export` | second | Claude Desktop/Code, Gemini CLI, Cursor, VS Code, ChatGPT Developer Mode |
| `anthropic-memory-tool/` | Anthropic memory tool file ops over a virtual `/memories` tree rendered from Facts | third | Any Claude 4+ API app |
| `openai-proxy/` | OpenAI-compatible chat endpoint that injects recall and retains turns | later | Anything speaking the OpenAI API |

Rules:
- Resolve a `Scope` from credentials via Governance before calling anything (`ScopeResolver`, bearer API key, one bank per request).
- Never return engine text; only Facts and Episodes read under the Scope.
- Every read (recall, list, get) and every write writes an audit entry with ids only; writes audit inside the same transaction as the change. Capability denials are audited; failed authentication (401) and missing grants (403 before a Scope exists) are not, because there is no verified principal to attribute them to.
- Ids are server-generated. Idempotent retain uses `externalRef` (unique per bank). Client-chosen ids would be a cross-tenant existence oracle.

## REST API (v1)

All bank-scoped routes take `Authorization: Bearer mem_...`. Errors: 400 invalid body, 401 bad key, 403 no grant, missing capability or tenant mismatch, 404 bank/fact/unknown path, 409 duplicate episode or fact / confirm on a retracted fact, 422 unknown source episode.

| Method | Path | Capability | Does |
|---|---|---|---|
| GET | `/healthz` | none | liveness |
| POST | `/v1/banks/:bankId/episodes` | write | retain an Episode `{source, text, role?, kind?, occurredAt?, externalRef?}` → 201 `{episodeId}` |
| POST | `/v1/banks/:bankId/recall` | read | `{query, limit?, asOf?, includeEpisodes?}` → `{facts[], episodes[]}` with scores |
| POST | `/v1/banks/:bankId/facts` | write | assert a client-authored Fact `{statement, sourceEpisodeIds[], validFrom?, predicate?}` → 201 Fact, born `asserted` |
| GET | `/v1/banks/:bankId/facts?asOf=` | read | current facts (bi-temporal, as of now or `asOf`) |
| GET | `/v1/banks/:bankId/facts/:factId` | read | one fact, same policy as search |
| POST | `/v1/banks/:bankId/facts/:factId/confirm` | write | mark provenance confirmed |
| POST | `/v1/banks/:bankId/facts/:factId/dispute` | write | mark provenance disputed |

Bootstrap with the admin CLI (`npm run admin -- create-bank | create-principal | grant | issue-key`). The server process also runs the outbox relay that projects Memory events into the retrieval engine (`IndexingProjector`), so a retained episode becomes recallable within `OUTBOX_POLL_MS`. A failed event retries with exponential backoff (1s, 2s, 4s, ... capped at 5 min) and is dead-lettered after 5 attempts (`memory.outbox.failed_at`), logged, and never blocks the queue; `npm run admin -- requeue-dead-letters` puts dead letters back.
