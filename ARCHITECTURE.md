# Memory layer: practical DDD architecture

Status: draft, 2026-10-23. Companion to `Self hosted AI memory layer landscape.md` (research) and `spike-plan-hindsight-vs-honcho.md` (engine selection).

## 0. What we are building, in one paragraph

A self-hosted **system of record for memory** that any model provider can read from and write to. We own the episode log, the fact store, provenance, validity and deletion semantics. Retrieval engines (pgvector, Hindsight, Honcho, whatever wins the spike) are **replaceable components mounted beneath** our model, never the source of truth. Clients attach through one surface (remote MCP with OAuth, plus an Anthropic memory-tool handler), and every memory can be exported in a portable format and regenerated into any provider's import format.

"Practical DDD" here means: a single repo and a single package, one Postgres, bounded contexts as folders under `src/`, pure domain code with no IO, ports and adapters at the edges, domain events persisted in an outbox table rather than a message bus, and no CQRS/event-sourcing until a measured need appears. We model the core domain carefully and keep everything else thin.

## 1. Ubiquitous language

| Term | Meaning | Not to be confused with |
|---|---|---|
| **Subject** | The person or agent a memory is about and belongs to. The unit of ownership and the unit of erasure. | A tenant (billing/org boundary) or a Principal (who is calling) |
| **Bank** | The isolated memory store for one Subject within one Tenant. Every read and write names exactly one Bank. | A database schema; an engine's "bank"/"workspace" (those are adapter details) |
| **Episode** | An immutable record of something that happened: a conversation turn, a tool result, an imported document. Append-only. The raw, non-lossy provenance. | A Fact |
| **Fact** | A durable, atomic statement believed about the Subject or their world, derived from one or more Episodes, with bi-temporal validity and provenance. | A chunk, an embedding, a "memory" in vendor terminology |
| **Validity** (world time) | When the fact was true in the world: `validFrom`, `validTo` (open-ended until superseded or closed) | Transaction time |
| **Transaction time** | When we learned and when we stopped believing: `recordedAt`, `retractedAt` | Validity |
| **Supersession** | Fact B replaces Fact A: A gets `validTo` (world time) and `supersededBy: B`, B links `supersedes: A`. A is still believed about its interval, so point-in-time recall finds it. Nothing is retracted, overwritten or deleted. | Deletion, Invalidation |
| **Invalidation** | A fact is marked no longer believed at all (`retractedAt`), with a reason. Used when we were wrong, not when the world moved on. | Deletion, Supersession |
| **Provenance** | Source Episode ids, writer Principal, extractor model id and version, confirmation state (`asserted`, `confirmed`, `disputed`) | Metadata tags |
| **Scope** | The (Tenant, Bank, Principal grants) tuple that every operation runs under. Enforced on every read path, including GET by id. | An API key |
| **Principal** | The caller: a human, an agent, a tool integration. Has grants on Banks. | A Subject (the Principal may act on behalf of one) |
| **Erasure** | A compliance deletion of a Subject's data across facts, episodes, embeddings, caches and engine stores, verified by re-query, with a receipt in the audit log. | Invalidation, decay, eviction |
| **Recall** | A read: given a Scope and a query, return relevant Facts (and optionally Episodes) with provenance. | Search inside an engine |
| **Retain** | A write: record an Episode, then (async) extract candidate Facts. | Saving a file |
| **Engine** | A pluggable retrieval/indexing component behind the `RetrievalEngine` port (pgvector, Hindsight, Honcho). Derived state only, rebuildable from Episodes and Facts. | The system of record |
| **Attachment** | A protocol surface a client uses to reach us: MCP, Anthropic memory tool, REST, later an OpenAI-compatible proxy. | A bounded context with its own model (it has none) |

Rule: code, tables, API fields and docs use these words and no synonyms.

## 2. Bounded contexts

```
                     ┌──────────────────────────┐
                     │   Attachment (generic)   │  MCP · memory-tool · REST
                     └────────────┬─────────────┘
                                  │ commands / queries (application API)
       ┌──────────────────────────┼───────────────────────────────┐
       │                          ▼                               │
       │  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐  │
       │  │  Governance  │◀──│    Memory    │──▶│  Retrieval   │  │
       │  │  (core)      │   │   (core)     │   │ (supporting) │  │
       │  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘  │
       │         │ policy on        │ events           │ Engine   │
       │         │ every read       ▼                  ▼ port     │
       │         │          ┌──────────────┐    pgvector/Hindsight/│
       │         │          │  Extraction  │    Honcho adapters    │
       │         │          │ (supporting) │                       │
       │         │          └──────────────┘                       │
       │   ┌─────┴────────┐          ┌──────────────┐              │
       │   │ Portability  │          │  Evaluation  │ (separate    │
       │   │ (supporting) │          │  (tooling)   │  deployable) │
       │   └──────────────┘          └──────────────┘              │
       └──────────────────────── one Postgres ─────────────────────┘
```

### 2.1 Memory (core domain)

The system of record. Everything else derives from it.

- **Aggregates**
  - `Bank` (aggregate root for scoping; small: id, tenantId, subjectId, status, policy settings)
  - `Episode` (immutable; aggregate of one)
  - `Fact` (aggregate root; owns its Validity, Provenance, supersession links)
- **Value objects**: `Validity`, `TransactionTime`, `Provenance`, `ModelRef` (provider, model, version), `Confidence`, `FactStatement` (text plus optional structured predicate)
- **Invariants**
  1. An Episode is never updated or deleted except through Erasure.
  2. A Fact always carries at least one source Episode id and a writer Principal. No orphan facts.
  3. Supersession closes the validity interval and links; invalidation retracts the belief. Neither deletes.
  4. `validFrom <= validTo`; `recordedAt <= retractedAt`.
  5. A Fact belongs to exactly one Bank, forever.
  6. Extractor `ModelRef` is recorded on every machine-written Fact (model drift is a correctness issue).
- **Domain events** (persisted to outbox, same transaction): `EpisodeRecorded`, `FactAsserted`, `FactSuperseded`, `FactInvalidated`, `FactConfirmed`, `FactDisputed`
- **Domain services**: `WritePolicy` (contradiction check ordered **before** the near-duplicate gate; decides assert / supersede / invalidate / historical / reject), `ConflictResolver` (executes the decision: a newer "updates" supersedes, a newer "contradicts" invalidates, an older candidate becomes history; performs no IO)
- **Repositories (ports)**: `BankRepository`, `EpisodeRepository`, `FactRepository`, `Outbox`

### 2.2 Governance (core domain, cross-cutting policy)

This is the part nobody ships in open source and the reason the layer exists. It is a separate context because its model (principals, grants, erasure, audit) changes for different reasons than the memory model.

- **Aggregates**: `Principal` (with `Grant[]`: bank id, capabilities read/write/admin/erase), `ErasureRequest` (state machine: `requested → inventoried → deleted → verified → receipted`; fails closed), `AuditLog` (append-only, hash-chained entries)
- **Policies** (pure functions used by Memory's application layer on every operation): `canRead(scope, bankId)`, `canWrite(...)`, `canErase(...)`. A GET by id goes through the same policy as a search. No bypass path exists.
- **Events**: `AccessDenied`, `ErasureRequested`, `ErasureAccessRevoked`, `ErasureVerified`, `ErasureReceiptIssued`, `HistoryRedacted`
- **Rules**
  - Audit entry is written *before* the destructive action; if the audit write fails, the action does not happen.
  - Erasure fans out to every store that holds Subject data (each context implements the `ErasableStore` port; engine adapters implement `countBank` / `purgeBank`), then re-queries each and records zero-hit proof in the receipt. Access goes with the data: Governance's own store removes every grant on the bank and revokes the API keys of principals granted on no other bank (`erasure.access_revoked`, which carries the revoked principal ids; each key records `revocation_reason` and the `erasure_request_id`), so the receipt proves zero grants and, independently of them, zero live keys among those the request revoked (the re-count finds them by the request id on the key, not through the grants). The bank records which engine holds its index; an erasure refuses to run against a server whose engine differs, so it can never purge the wrong engine. `admin verify-receipt` recomputes a receipt's digest and re-queries every store after the fact.
  - Redaction removes content from historical Fact versions and Episodes while keeping the tombstone and audit chain.

### 2.3 Extraction (supporting)

Turns Episodes into candidate Facts. Strategy, not identity: it will change often and must be replaceable per Bank.

- **Port**: `Extractor.extract(scope, { trigger, recent, existing }) → { candidates: ExtractedCandidate[], usage }` (one LLM-backed implementation over the `LlmClient` port, whose single adapter is the Vercel AI SDK with provider packages; a `noopExtractor` for the pgvector-only arm)
- **Application service**: `RetainPipeline` has two decoupled halves. As an outbox consumer it only enqueues `EpisodeRecorded` episodes into `extraction.runs` (cheap, idempotent), so indexing never waits on a model. As a worker (its own loop) it claims one due row at a time (`FOR UPDATE SKIP LOCKED`, stale claims retaken), gathers context (recent episodes, facts current now), runs the Extractor outside any transaction with a hard timeout, and submits candidates to Memory's `WriteExtractedFacts` command, which is idempotent per trigger episode and applies `WritePolicy` and `ConflictResolver` in one transaction. Failures back off (30s doubling to 1h, 8 attempts); non-retryable model errors dead-letter the episode. Banks without an extractor, and episodes not authored by the Subject (assistant or tool output), are skipped.
- **Records** extractor `ModelRef`, prompt version and a faithfulness score into Provenance.
- **Owns**: the per-episode write budget (facts shown to the model capped, episode text truncated, output tokens capped), the token/latency ledger per episode (`extraction.runs`), retry policy, and idempotency keyed on the trigger episode.

### 2.4 Retrieval (supporting)

Indexes Facts and Episodes for recall. Pure derived state.

- **Port**: `RetrievalEngine` with `index(fact|episode)`, `recall(query, scope, options) → RankedHit[]`, `purgeSubject(subjectId)`, `rebuild(bankId)`
- **Adapters**: `PgvectorEngine` (default, in our Postgres), `HindsightEngine`, `HonchoEngine` (map Bank to their bank/workspace; map Subject purge to their deletion APIs and then verify)
- **Rule**: hits carry our Fact ids; the application layer re-reads Facts from the Memory repository and applies Governance policy before returning anything. An engine's own text is never returned to a caller directly.
- **Rebuildable**: dropping an engine and replaying Facts must restore it. This is what makes engines swappable and the spike honest.

### 2.5 Attachment (generic subdomain, thin)

Protocol adapters that translate to application commands and queries. No domain model.

- `mcp/`: Streamable HTTP MCP server (stateless, one server per request bound to the resolved Scope) behind the same bearer API keys and middleware as REST; tools `recall`, `retain`, `list_facts`, `confirm_fact`, `dispute_fact` over the same handlers. **Done.** OAuth, an `export` tool and resource URIs are deferred.
- `anthropic-memory-tool/`: handler for the client-side memory tool's file operations, backed by the Bank (a virtual `/memories` tree rendered from Facts; writes become Episodes).
- `rest/`: same commands for SDKs and the eval arm adapters.
- Later: `openai-proxy/` (OpenAI-compatible endpoint that injects recall and retains turns transparently).

### 2.6 Portability (supporting)

- **Export**: `BankExport` as JSONL (Facts with validity, provenance, tombstones) plus a Markdown rendering. Deterministic, so diffs are meaningful.
- **Import adapters**: Claude Code memory dir (Markdown with frontmatter), Claude/Gemini chat exports, ChatGPT export ZIP. Each import creates Episodes with `source` provenance; extraction then runs as usual. Imports never create Facts directly.
- **Render**: generate the Claude and Gemini paste-import formats from a Bank (makes us the system of record for provider memory too).

### 2.7 Evaluation (tooling, not ours to build)

We do **not** build an evaluation framework. Existing ones already do datasets, model-graded scoring, caching, token and latency capture, and result tables. We own only what no framework can supply:

- the question set over our own transcripts (`eval/questions/`)
- the frozen grader prompt and its sanity tests
- one thin adapter per arm (full context, pgvector, Hindsight, Honcho) that calls our REST attachment or the `RetrievalEngine` port
- a short script for the statistics the framework does not compute: cluster-robust 95% CI by conversation and the minimum detectable difference

Framework: `promptfoo` (chosen on spike day 1, 2026-10-23; 0.120.x as a devDependency). It supplies custom TypeScript providers for the arms, `llm-rubric` grading with our committed grader prompt, a disk cache used by both the arms' answering calls and the grader, and token and latency capture per result. Two things it did not supply live in `eval/`: a verdict check for the grader sanity cases (its `not-llm-rubric` does not invert model-graded assertions) and the plan's section-6 table (`eval/stats/summarize.ts`). See `eval/README.md`.

`eval/` depends on the same ports as production and is never imported by `src/`.

## 3. Context map

| Upstream → Downstream | Relationship | Contract |
|---|---|---|
| Memory → Retrieval | Published language | `FactIndexed` payload (id, bank, text, validity, embeddings input) |
| Memory → Extraction | Customer/supplier | Extraction consumes `EpisodeRecorded`, submits commands back through Memory's application API |
| Governance → Memory | Conformist (Memory conforms to Governance policy on every operation) | `Scope` value object and `AccessPolicy` interface in the shared kernel |
| Memory → Portability | Published language | Export schema v1 (versioned JSON Schema file) |
| Memory + Governance → Attachment | Open host service | Application API (commands/queries), the only thing Attachment may call |
| Engines (Hindsight, Honcho) → Retrieval | Anti-corruption layer | Each adapter maps their vocabulary to ours; nothing from them crosses into the domain |
| Providers (Claude, Gemini, OpenAI) → Extraction | Anti-corruption layer | `LlmClient` port; provider SDKs stay in infrastructure |

**Shared kernel** (deliberately tiny): `Ids` (branded strings), `Clock`, `Scope`, `Provenance`, `Validity`, `ModelRef`, `Result<T,E>`, `DomainEvent` base.

## 4. Layering inside each context folder

```
src/<context>/
  index.ts         the context's public surface; other contexts import only this
  domain/          entities, value objects, events, policies, domain services  (pure TS, no imports from infrastructure)
  application/     command & query handlers, use cases, transaction boundary, outbox publish
  ports/           interfaces the application needs (repositories, engines, clocks, LLM clients)
  infrastructure/  adapters implementing ports (postgres, hindsight, honcho, anthropic, http)
test/<context>/    fast unit tests for domain and application code, with in-memory adapters
```

Dependency rules: `domain ← application ← infrastructure`; `ports` are declared in the context and implemented in its `infrastructure/`. Across contexts, import only `../<other>/index.js`. Both rules are enforced with an ESLint `no-restricted-imports` configuration (to add with the first infrastructure adapter).

## 5. Persistence (one Postgres, one schema per context)

- `memory.banks` (with `engine`: the retrieval engine holding the bank's index, set at creation and changed by `admin reindex`), `memory.episodes` (append-only: a trigger refuses UPDATE, and DELETE unless the session flag `mem.erasure = 'on'` is set by the Erasure workflow), `memory.facts` (bi-temporal columns, `supersedes_id` / `superseded_by_id`, CHECK that provenance has at least one source episode, DELETE refused outside erasure), `memory.outbox`
- `governance.principals`, `governance.grants`, `governance.erasure_requests`, `governance.audit_log` (hash chain columns, immutable by trigger)
- `retrieval.pgvector_index` (our default engine; derived state, no foreign keys to `memory.*` so it can be dropped and rebuilt; `embedding` is typed to `vector(N)` with a cosine HNSW index by `admin pin-dimensions`, N = `EMBEDDING_DIMENSIONS`, recall through the index uses pgvector's iterative scans so bank filtering cannot shorten results), `retrieval.settings` (the pinned N and embedder id; the server refuses to boot on a mismatch), plus external engines' own storage
- `portability.exports` (manifest of produced exports, for receipts)

Migrations are plain SQL files owned by each context (`src/<context>/infrastructure/**/migrations/*.sql`), applied in context order by `src/platform/postgres/migrator.ts` under an advisory lock and recorded in `public.schema_migrations`. `npm run db:migrate` applies them; tests apply them on setup. DDL whose shape depends on the deployment (the `vector(N)` column and its HNSW index) is not a migration but an explicit, idempotent admin step that records what it did in `retrieval.settings`.

`src/platform/` holds infrastructure utilities shared by several contexts (Postgres pool, transaction helper, migrator). It is not a bounded context and contains no domain logic.

### How bank isolation works

One bank must never see or change another bank's rows. Two layers keep it that way, and a check in the test suite proves the second one.

1. **Governance decides first.** Every application handler asks `AccessPolicy` (`src/governance/domain/access-policy.ts`) whether the caller's Scope may touch the bank, before any query runs. The Scope comes from the API key, and `ScopeResolver` refuses a bank of another tenant.
2. **Every query pins itself to one bank.** Each repository statement on a bank's tables carries the bank in its WHERE clause (`bank_id = $1`), even though layer 1 already said yes. If a handler ever forgot its policy check, the query would still only return that bank's rows. The tables and the column that pins each one are listed in `src/platform/postgres/bank-isolation.ts` (`SCOPED_TABLES`): `bank_id` for bank data, `tenant_id` for the audit log, and the principal for Governance's identity tables (one principal belongs to one tenant).

**The guard.** Layer 2 is checked by machine, not by reading the code. During `npm test`, every SQL statement that application code sends to the test database goes through `test/helpers/query-guard.ts`. It parses the statement with the real Postgres parser (`libpg-query`) and looks at every SELECT, UPDATE and DELETE, every subquery (in WHERE, the select list, SET and RETURNING), every CTE, and the update half of an upsert: each listed table must be pinned by an equality on its column, joined by AND, to a parameter or constant, or to another pinned column. `bank_id = $1 OR ...` does not count, a subquery is not accepted as the value, an outer join's ON pins only the joined (nullable) side, and an upsert must keep every scope column of the row it overwrites (`WHERE t.bank_id = EXCLUDED.bank_id`). No UPDATE may assign a scope column: a row never moves to another bank. Statement kinds the guard does not interpret (TRUNCATE, MERGE, COPY, DROP TABLE and the like) fail on a listed table, and DO blocks and function definitions fail outright, since their bodies are strings the parser cannot see into. Note that `bank_id = ANY($1)` counts as a pin even when the array names several banks: the guard checks that a statement is bounded by banks the caller supplied, not how many. Production code does not load the guard and pays nothing for it.

**The allowlist.** A few statements span banks on purpose: the outbox relay and the extraction and erasure workers picking up the next job of any bank, the extraction worker's sweep of stale claims, queue counts and requeues for the operator, looking up an erasure request by its id (operator and worker), API key lookup and revocation by hash (before anyone knows the bank), erasure's revocation of keys, and the vector index's checks for other embedders plus the admin pin. Each is named in `CROSS_BANK_STATEMENTS` in `bank-isolation.ts` with the function that runs it, the tables it may leave unpinned, and why; its SQL starts with the tag `crossBank("<name>")`, which becomes the comment `/* cross-bank: <name> */`. The tag excuses only the entry's tables: any other listed table in the same statement must still be pinned. To add one: write the entry (function, tables, reason), put `${crossBank("<name>")}` in front of the SQL, and make sure a test runs it. The run fails if an entry is never exercised, if a tag names no entry, or if a tagged statement's tables turn out to be pinned after all, so the list cannot rot. The "never exercised" check needs the whole suite; it is skipped when a run is limited to some files or tests (a path, `-t`, `--shard`, `--changed`, `--related`).

**What a failure looks like.** The offending query is not sent; it rejects in the test that ran it, and the test file fails with:

```
query guard: statement not pinned to one bank
  memory.episodes is not pinned by bank_id
  at PgEpisodeRepository.get (src/memory/infrastructure/postgres/repositories.ts:67:36)
  SQL: SELECT * FROM memory.episodes WHERE id = $1
```

The fix is almost always to add the bank to the WHERE clause; an allowlist entry is for a statement that really must see every bank. The end of each run prints how many statements were checked and how many were allowlisted. A separate test (`test/platform/cross-bank.test.ts`) fills two banks and calls every bank-scoped repository method for one, proving the other is neither seen nor changed.

**What the guard does not see.** Statements no test runs: today two, both deliberately cross-bank and untagged because no test exercises them (the embedder row count in `admin reindex`, `src/cli/admin.ts`, and the boot warning about banks held by another engine, `src/attachment/rest/main.ts`). Migrations (they run before the guard is installed), functions and triggers (opaque bodies), and SQL that test files send themselves for fixtures and assertions.

**Why not row-level security.** Postgres RLS would enforce the same rule inside the database. The user chose this code-layer enforcement on 2026-10-28 so the rule stays readable and owned in TypeScript. RLS remains an option for a multi-tenant hosted deployment, where a database-side backstop against a compromised application is worth its cost (a session variable per transaction, a non-owner role, and policies on every table).

## 6. Request flows

**Retain** (write): Attachment → `RecordEpisode` command → Governance `canWrite` → bank tenant must equal scope tenant → `Episode` persisted + `EpisodeRecorded` to outbox + `episode.recorded` audit entry (one transaction) → return. Async, relay loop: Retrieval `IndexingProjector` indexes the episode; Extraction enqueues it. Async, worker loop: claim → `LlmExtractor` (recent episodes + current facts → structured candidates with relations to existing facts) → Memory `WriteExtractedFacts`: code guards (Subject-authored source, no secrets) → `WritePolicy` (contradiction check, then dedupe) → `ConflictResolver`: a newer "updates" supersedes (old validity closed and linked, still recallable for its interval), a newer "contradicts" invalidates (old retracted), an older candidate is recorded as history marked disputed → `FactAsserted` / `FactSuperseded` / `FactInvalidated` / `FactDisputed` → `extraction.applied` audit entry → next relay pass indexes the facts.

**Recall** (read): Attachment → `Recall` query with `Scope` → Governance `canRead` → `RetrievalEngine.recall` → Fact and Episode ids → `FactRepository.getMany(scope, ids)` / `EpisodeRepository.get(scope, id)` (policy applied again) → response with provenance and validity → `recall.served` audit entry (ids only). Application handlers write the audit entries themselves: for writes inside the unit-of-work transaction (entry and change commit or roll back together), for reads right after the read. The attachment only audits capability denials.

**Erase**: Attachment (REST or admin CLI; never MCP) → `EraseBank` → Governance `canErase` → `ErasureRequest` created (`requested`; the database refuses a second in-flight one per bank) and the `erasure.requested` audit entry, in one transaction (if the entry fails, nothing is recorded or deleted) → REST answers `202` with the record; the request id is the handle. Async, the erasure worker loop in the server process: claim the oldest in-flight request (`FOR UPDATE SKIP LOCKED`, a claim token, `claimed_at`; a pass that lands no step for `ERASURE_STALE_MS` is presumed dead and retaken, the workflow resuming from the stored state) → bank frozen (`erasing`, the recorded engine re-checked under the row lock) → inventory every `ErasableStore` (memory facts/episodes/outbox, retrieval engine, extraction runs, portability exports, and last the access store: grants on the bank, keys of principals dedicated to it) → purge each store, each deletion saved on the request before the next store starts, every save a compare-and-set on terminality and the claim token (Memory in one transaction under `mem.erasure = 'on'`; the access store's purge is audited `erasure.access_revoked` with the revoked principal ids, and each key records the request that revoked it) → `erasure.deleted` → re-count every store given the recorded deletions (the keys store counts the live keys this request marked); any hit fails closed → bank tombstoned (`erased`) → receipt (canonical-JSON digest over request id, subject, per-store deletions with their evidence, zero counts, time) → `erasure.receipt_issued` audit entry carrying the digest. Any failure: request `failed` with the step and error kind, bank stays frozen, a new request may retry; a pass retaken or abandoned mid-way stops without writing. `admin verify-receipt` later recomputes the digest, verifies the whole tenant chain, requires the tombstone and re-counts every store.

## 7. What we deliberately do not do (yet)

- No microservices, no monorepo. One repo, one package, one deployable. Contexts are folders.
- No event bus. Outbox table and a relay loop (per-event savepoints, attempt counting, dead-letter after 5 failures). Upgrade only if a second deployable needs the events.
- No CQRS read models. Postgres queries are enough at our scale; add when a recall path proves slow.
- No event sourcing of aggregates. The Episode log is append-only by nature; Facts are state with history via bi-temporal columns. That gives us replay without the ceremony.
- No decay or eviction by default. Only Erasure removes data. Decay becomes a configurable Bank policy when state-change tracking exists.
- No browser extension. Attachment is MCP, memory tool, REST.

## 8. Build order

1. Shared kernel + Memory domain with unit tests (no IO). Invariants 1-6 as tests. **Done.**
2. Governance domain: `Scope`, `AccessPolicy`, `ErasureRequest` state machine, hash-chained audit entries. Unit tests. **Done.** Postgres repositories for principals, API keys and the audit log (per-tenant advisory lock, canonical JSON hashing) **done**. Erasure workflow **done**: `EraseBank` (audit entry before any deletion, bank frozen, per-store inventory / purge / re-count through the `ErasableStore` port implemented by Memory, Retrieval, Extraction, Portability and Governance (grants and keys, last), receipt with a canonical-JSON digest chained into the audit log as `erasure.receipt_issued`, fails closed with deletions recorded per store, refuses a bank recorded in an engine it does not purge), `governance.erasure_requests` persistence with one in-flight request per bank enforced by a partial unique index, REST `POST/GET /v1/banks/:bankId/erasure`, `admin erase-bank` / `erasure-status` / `erasure-abandon` / `verify-receipt`. Memory deletes under `SET LOCAL mem.erasure = 'on'`; the bank row stays as an `erased` tombstone. Hardening **done** (2026-10-24): pinned `vector(N)` column with HNSW index, access revoked on erasure, receipt verification, rate limits, per-bank engine record.
3. Postgres adapters for Memory, unit of work, outbox relay, migrations for all three schemas. Contract tests. **Done.**
4. Retrieval: `PgvectorEngine` behind the `RetrievalEngine` port, `HashingEmbedder` for offline tests, `AiSdkEmbedder` for production (OpenAI, Google, OpenAI-compatible; configured by `EMBEDDER`), `EngineMemoryFinder` adapter into Memory's recall. Rows record their embedder; recall filters by it; `admin reindex` rebuilds a bank after a switch. This is spike arm B. **Done.**
5. Extraction: one LLM adapter behind `LlmClient` (Vercel AI SDK: Anthropic, Google, OpenAI, OpenAI-compatible), `LlmExtractor` with a versioned prompt and structured output, `RetainPipeline` off the outbox with an idempotency claim per episode and a per-episode token/latency ledger (`extraction.runs`), `WriteExtractedFactsHandler` in Memory applying WritePolicy + ConflictResolver (supersede or record-as-historical). **Done.** Extraction is per bank: `admin set-extractor --bank <id> --model provider:model`.
6. Attachment: REST first (the eval arm adapters need it), then MCP, then the Anthropic memory-tool handler. **REST and MCP done**: scope resolution via API keys, retain, recall (facts and episodes), assert/list/get/confirm/dispute, audit on every served read and write, outbox relay + `IndexingProjector` in the same process, admin CLI for bootstrap.
7. `HindsightEngine` and `HonchoEngine` adapters (spike arms C and D) using the same `RetrievalEngine` port and the same contract tests. **Done** (2026-10-23): both over the engines' official TypeScript SDKs, selected by `ENGINE` in the composition root next to `EMBEDDER`, running as optional docker-compose profiles; contract runs gated behind `RUN_ENGINE_TESTS=1` (`npm run test:engines`). Neither engine expresses point-in-time validity, our embedder id, or a single-memory hard delete; the adapters carry validity in engine metadata and filter at recall, soft-retire on retract, and prove erasure by what the engine's API reports after deleting the bank or workspace (gaps in `research_notes/hindsight-2026-10-23.md`, `research_notes/honcho-2026-10-23.md`).
8. Portability: JSONL/Markdown export, Claude Code memory-dir import.
9. Wire the four arms into the chosen eval framework through the REST attachment and run the spike. **Stage 1 done** (2026-10-23): promptfoo harness, corpus builder over the local Claude Code transcripts (redacted, this repo's own sessions excluded), 40 drafted questions awaiting human audit, frozen grader prompt with sanity cases, arms A (full context) and B (pgvector through REST, per-conversation `eval-*` banks) and a smoke run recorded in `eval/RESULTS.md`. **Stage 2 built** (2026-10-23): arms C and D run the engines natively through their official SDKs (`eval/arms/hindsight.ts`, `eval/arms/honcho.ts`), the cluster-robust CI / MDD script (`eval/stats/ci.ts`), the model audit of the 40 questions, and the engine compose profiles; the decision run over the 40 audited questions is complete at this corpus size (`eval/RESULTS.md`, `spike-results.md`: adopt pgvector, keep the engines behind the port).

Steps 1-4 and 9 are what the two-week spike needs. The DDD structure is not extra work for the spike; it is what makes arms B, C and D swappable behind one port.
