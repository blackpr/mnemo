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
| **Validity** (world time) | When the fact was true in the world: `validFrom`, `validTo` (open-ended until invalidated) | Transaction time |
| **Transaction time** | When we learned and when we stopped believing: `recordedAt`, `retractedAt` | Validity |
| **Supersession** | Fact B replaces Fact A: A gets `validTo` and `retractedAt`, B links `supersedes: A`. Nothing is overwritten or deleted. | Deletion |
| **Invalidation** | A fact is marked no longer believed, with a reason and a causing Episode. | Deletion |
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
  3. Supersession and invalidation never delete; they close intervals and link.
  4. `validFrom <= validTo`; `recordedAt <= retractedAt`.
  5. A Fact belongs to exactly one Bank, forever.
  6. Extractor `ModelRef` is recorded on every machine-written Fact (model drift is a correctness issue).
- **Domain events** (persisted to outbox, same transaction): `EpisodeRecorded`, `FactAsserted`, `FactSuperseded`, `FactInvalidated`, `FactConfirmed`, `FactDisputed`
- **Domain services**: `ConflictResolver` (recency-wins with explicit invalidation; returns a decision, performs no IO), `WritePolicy` (filter/canonicalize/dedupe rules; contradiction check ordered **before** the near-duplicate gate)
- **Repositories (ports)**: `BankRepository`, `EpisodeRepository`, `FactRepository`, `Outbox`

### 2.2 Governance (core domain, cross-cutting policy)

This is the part nobody ships in open source and the reason the layer exists. It is a separate context because its model (principals, grants, erasure, audit) changes for different reasons than the memory model.

- **Aggregates**: `Principal` (with `Grant[]`: bank id, capabilities read/write/admin/erase), `ErasureRequest` (state machine: `requested → inventoried → deleted → verified → receipted`; fails closed), `AuditLog` (append-only, hash-chained entries)
- **Policies** (pure functions used by Memory's application layer on every operation): `canRead(scope, bankId)`, `canWrite(...)`, `canErase(...)`. A GET by id goes through the same policy as a search. No bypass path exists.
- **Events**: `AccessDenied`, `ErasureRequested`, `ErasureVerified`, `ErasureReceiptIssued`, `HistoryRedacted`
- **Rules**
  - Audit entry is written *before* the destructive action; if the audit write fails, the action does not happen.
  - Erasure fans out to every store that holds derived data (engine adapters implement `purgeSubject`), then re-queries each and records zero-hit proof in the receipt.
  - Redaction removes content from historical Fact versions and Episodes while keeping the tombstone and audit chain.

### 2.3 Extraction (supporting)

Turns Episodes into candidate Facts. Strategy, not identity: it will change often and must be replaceable per Bank.

- **Port**: `Extractor.extract(episodes, existingFacts, scope) → CandidateFact[]` (LLM-backed adapters per provider; a `NoopExtractor` for the pgvector-only arm)
- **Application service**: `RetainPipeline` consumes `EpisodeRecorded` from the outbox, runs the Extractor, passes candidates through Memory's `WritePolicy` and `ConflictResolver`, and issues `AssertFact`/`SupersedeFact` commands. Runs async; never on the request path.
- **Records** extractor `ModelRef`, prompt version and a faithfulness score into Provenance.
- **Owns**: the per-turn write budget (token accounting), batching, and retry with idempotency keyed on Episode id.

### 2.4 Retrieval (supporting)

Indexes Facts and Episodes for recall. Pure derived state.

- **Port**: `RetrievalEngine` with `index(fact|episode)`, `recall(query, scope, options) → RankedHit[]`, `purgeSubject(subjectId)`, `rebuild(bankId)`
- **Adapters**: `PgvectorEngine` (default, in our Postgres), `HindsightEngine`, `HonchoEngine` (map Bank to their bank/workspace; map Subject purge to their deletion APIs and then verify)
- **Rule**: hits carry our Fact ids; the application layer re-reads Facts from the Memory repository and applies Governance policy before returning anything. An engine's own text is never returned to a caller directly.
- **Rebuildable**: dropping an engine and replaying Facts must restore it. This is what makes engines swappable and the spike honest.

### 2.5 Attachment (generic subdomain, thin)

Protocol adapters that translate to application commands and queries. No domain model.

- `mcp/`: remote streamable-HTTP MCP server with OAuth; tools `recall`, `retain`, `list_facts`, `confirm`, `dispute`, `export`. Resource URIs expose Facts read-only.
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

Framework choice: `promptfoo` fits the TypeScript stack (custom JS providers, model-graded assertions, per-case latency and token capture). `Inspect AI` is the Python alternative. Confirm current features on day 1 of the spike and pick one; do not write a runner.

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

- `memory.banks`, `memory.episodes` (append-only, no UPDATE grant for the app role), `memory.facts` (bi-temporal columns, `supersedes_id`), `memory.outbox`
- `governance.principals`, `governance.grants`, `governance.erasure_requests`, `governance.audit_log` (hash chain column, trigger-protected)
- `retrieval.pgvector_index` (our default engine), plus external engines' own storage
- `portability.exports` (manifest of produced exports, for receipts)

Row-level security on `memory.*` keyed by `bank_id` as a second line of defence behind application policy. Migrations per schema, owned by the context.

## 6. Request flows

**Retain** (write): Attachment → `RecordEpisode` command → Governance `canWrite` → `Episode` persisted + `EpisodeRecorded` to outbox (one transaction) → return. Async: outbox relay → Extraction `RetainPipeline` → candidates → `WritePolicy` (contradiction check, then dedupe) → `ConflictResolver` → `AssertFact` / `SupersedeFact` → `FactAsserted` → Retrieval indexes.

**Recall** (read): Attachment → `Recall` query with `Scope` → Governance `canRead` → `RetrievalEngine.recall` → Fact ids → `FactRepository.getMany(scope, ids)` (policy applied again) → response with provenance and validity → `RecallServed` audit entry (ids only).

**Erase**: Attachment → `RequestErasure` → Governance aggregate `ErasureRequest` → audit entry first → inventory (facts, episodes, engine stores, caches) → delete everywhere → verify zero hits per store → receipt (hash, counts, timestamps) → `ErasureReceiptIssued`.

## 7. What we deliberately do not do (yet)

- No microservices, no monorepo. One repo, one package, one deployable. Contexts are folders.
- No event bus. Outbox table and a relay loop. Upgrade only if a second deployable needs the events.
- No CQRS read models. Postgres queries are enough at our scale; add when a recall path proves slow.
- No event sourcing of aggregates. The Episode log is append-only by nature; Facts are state with history via bi-temporal columns. That gives us replay without the ceremony.
- No decay or eviction by default. Only Erasure removes data. Decay becomes a configurable Bank policy when state-change tracking exists.
- No browser extension. Attachment is MCP, memory tool, REST.

## 8. Build order

1. Shared kernel + Memory domain with unit tests (no IO). Invariants 1-6 as tests.
2. Governance domain: `Scope`, `AccessPolicy`, `ErasureRequest` state machine, hash-chained audit entries. Unit tests.
3. Postgres adapters for both, outbox relay, migrations. Contract tests.
4. Retrieval: `PgvectorEngine`. This is spike arm B.
5. Extraction: one LLM adapter behind `LlmClient`, `RetainPipeline`. Record `ModelRef`.
6. Attachment: REST first (the eval arm adapters need it), then MCP, then the Anthropic memory-tool handler.
7. `HindsightEngine` and `HonchoEngine` adapters (spike arms C and D) using the same `RetrievalEngine` port and the same contract tests.
8. Portability: JSONL/Markdown export, Claude Code memory-dir import.
9. Wire the four arms into the chosen eval framework through the REST attachment and run the spike.

Steps 1-4 and 9 are what the two-week spike needs. The DDD structure is not extra work for the spike; it is what makes arms B, C and D swappable behind one port.
