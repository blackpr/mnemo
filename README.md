# mem

Self-hosted, provider-agnostic memory layer: a system of record for what AI assistants know about you, shared across Claude, Gemini, OpenAI and coding agents.

- `ARCHITECTURE.md` — the domain-driven design: ubiquitous language, bounded contexts, invariants, ports, build order
- `spike-plan-hindsight-vs-honcho.md` — two-week engine selection spike
- `Self hosted AI memory layer landscape.md` and `research_notes/` — the research behind both

## Layout

One package, one repo. Bounded contexts are folders under `src/`, each with `domain/`, `application/`, `ports/`, `infrastructure/` as needed.

```
src/shared-kernel   ids, Clock, Scope, Validity, Provenance, ModelRef, Result, DomainEvent
src/memory          core: Bank, Episode, Fact (bi-temporal), WritePolicy, events, repositories, RecordEpisode, Recall
src/governance      core: AccessPolicy, Principal/Grant, ErasureRequest (fails closed), hash-chained AuditLog
src/retrieval       RetrievalEngine port; adapters pgvector / Hindsight / Honcho
src/extraction      Extractor and LlmClient ports; RetainPipeline
src/attachment      REST, MCP, Anthropic memory tool, (later) OpenAI proxy
src/portability     export / import / render
src/platform        shared infrastructure utilities (Postgres pool, transactions, migrator); not a bounded context
test/<context>      unit tests for domain code (no IO) and Postgres-backed adapter tests (skipped without DATABASE_URL)
eval/               the spike: question set, grader prompt, arm adapters for an existing eval framework (no runner of our own)
```

Cross-context imports go through the context's `index.ts` only (e.g. `../governance/index.js`), never into its internals.

## Develop

```bash
npm install
npm run typecheck
npm test                 # domain tests only; database suites are skipped
```

With a database (Docker required):

```bash
npm run db:up            # pgvector/pgvector:pg17 on localhost:5433
cp .env.example .env
DATABASE_URL=postgres://mem:mem@localhost:5433/mem npm run db:migrate
DATABASE_URL=postgres://mem:mem@localhost:5433/mem npm test   # all suites, including Postgres adapters and the pgvector engine contract
```

Domain code (`src/*/domain`) has no IO and is covered by fast unit tests. Infrastructure adapters are covered by contract tests against a real Postgres; `test/retrieval/retrieval-engine.contract.ts` is the contract every engine adapter (pgvector, Hindsight, Honcho) must pass.
