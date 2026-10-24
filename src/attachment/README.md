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
- Rate limit: `RATE_LIMIT_PER_MINUTE` requests per API key per minute (default 600) over everything under `/v1`, REST and MCP alike, via `hono-rate-limiter`; the bucket is the key's sha256. Requests with no key or a malformed one share a bucket per client address, and a second ceiling per address (`RATE_LIMIT_PER_ADDRESS_PER_MINUTE`, default ten times the per-key limit) applies to everything from that address, so rotating made-up tokens does not dodge the limiter. The address is the TCP peer, never `X-Forwarded-For`: behind a reverse proxy every client shares the proxy's address bucket. Over a limit: `429 {"error":"rate_limited"}` with `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `RateLimit-Policy` and `Retry-After` describing the limiter that answered. Windows start at the first hit, so a burst of up to twice the limit is possible across a reset. The counters are in-process memory: more than one server instance needs a shared store (`@hono-rate-limiter/redis`, a `Store` over Postgres, or `rate-limiter-flexible`'s Postgres limiter), which is not built.

## REST API (v1)

All bank-scoped routes take `Authorization: Bearer mem_...`. Errors: 400 invalid body, 401 bad key, 403 no grant, missing capability or tenant mismatch, 404 bank/fact/erasure request/unknown path, 409 duplicate episode or fact / confirm on a retracted fact / write or export on a frozen, erasing or erased bank / erasure already in flight, 422 unknown source episode.

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
| GET | `/v1/banks/:bankId/export?format=jsonl\|markdown` | read | the whole bank (closed and retracted facts included) as a download; recorded in `portability.exports` and audited `export.produced` (see `src/portability/README.md`) |
| POST | `/v1/banks/:bankId/erasure` | erase | run the Erasure workflow to completion (audit entry first, freeze the bank, inventory, purge every store, re-count, receipt) → 201 request `{id, state: "receipted", stores[{store, countBefore, deleted, hitsAfter}], receipt{digest, issuedAt, deletions, stores}, failure: null}`, or 500 `{error: "erasure_failed", request}` with the same record in state `failed` (the bank stays frozen; POST again to retry; `admin erasure-abandon` unblocks a request a crash left in flight, which otherwise answers 409). Access goes with the data: every grant on the bank is deleted and the API keys of principals granted on no other bank are revoked, the caller's included (`erasure.access_revoked`); that store runs last, so a data-store failure still leaves the caller able to retry, while a failure in the re-count needs an operator to `admin grant --caps erase` again. The bank ends as a tombstone (`erased`): no more writes, empty recall. Irreversible. |
| GET | `/v1/banks/:bankId/erasure/:id` | erase | the same record later, for a principal that still holds `erase` on the bank: after a successful erasure nobody does (and `admin grant` refuses erased banks), so the record is read with `admin erasure-status` / `verify-receipt`; 404 for ids of other banks or tenants |

Bootstrap with the admin CLI (`npm run admin -- create-bank | create-principal | grant | issue-key`). The server process also runs two background loops. The outbox relay (every `OUTBOX_POLL_MS`) indexes episodes and facts and enqueues extraction work. The extraction worker (every `EXTRACTION_POLL_MS`) turns queued episodes into facts for banks with `set-extractor`, calling the model with a hard `LLM_TIMEOUT_MS`; a changed state supersedes the old fact, which stays recallable for its past interval via `asOf`, and a contradiction retracts it. `npm run admin -- extraction-status` shows queue counts; `requeue-extraction` retries failed and dead runs. A failed event retries with exponential backoff (1s, 2s, 4s, ... capped at 5 min) and is dead-lettered after 5 attempts (`memory.outbox.failed_at`), logged, and never blocks the queue; `npm run admin -- requeue-dead-letters` puts dead letters back.

## MCP

Endpoint: `POST /v1/banks/:bankId/mcp` (Streamable HTTP, stateless, JSON responses), same bearer API key, the same grants and the same rate limit as REST (a 429 surfaces in the MCP SDK client as a transport error, not a tool error, and the client does not back off on `Retry-After`). Each request builds an MCP server bound to the resolved Scope, so a key can only ever reach the bank in the URL. Tools call the exact same application handlers as REST and are audited identically; `retain` creates an episode (facts are extracted by the worker), `recall`/`list_facts` are read-only, `confirm_fact`/`dispute_fact` change provenance state. There is deliberately no `assert_fact` tool: models should retain the user's words and let extraction decide, not write facts directly. There is no erasure tool either: a compliance deletion is a human decision made over REST or `admin erase-bank`, never something an agent can trigger with the Subject's own key.

Connect Claude Code (user scope, so it works in every project):

```bash
claude mcp add --transport http --scope user mem http://localhost:8787/v1/banks/<bankId>/mcp --header "Authorization: Bearer mem_..."
```

Then `claude mcp list` should show `mem: ... - ✓ Connected`. Inside Claude Code, `/mcp` shows the five tools; the server's instructions tell the model to `recall` before answering questions about the user and to `retain` durable statements. Cursor, VS Code and Gemini CLI take the same URL and header in their MCP settings.
