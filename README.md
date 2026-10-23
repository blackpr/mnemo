# mem

Self-hosted, provider-agnostic memory layer: a system of record for what AI assistants know about you, shared across Claude, Gemini, OpenAI and coding agents.

- `STATUS.md` — where things stand, how to run, pitfalls, next steps (read first)
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
src/extraction      Extractor, LlmClient, run-store ports; LlmExtractor + prompt; RetainPipeline; AI SDK adapter
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
npm test                 # without TEST_DATABASE_URL: domain tests only, database suites are skipped
```

With a database (Docker required):

```bash
npm run db:up            # pgvector/pgvector:pg17 on localhost:5433, databases mem (dev) and mem_test (tests)
cp .env.example .env     # scripts load .env automatically
npm run db:migrate
npm test                 # all suites; database suites use TEST_DATABASE_URL (they TRUNCATE, so never the dev database)
npm run test:live        # additionally runs the paid real-provider tests (needs the keys in .env)
```

Run the REST attachment:

```bash
export DATABASE_URL=postgres://mem:mem@localhost:5433/mem
npm run admin -- create-bank --id bank-me --tenant t1 --subject me
npm run admin -- create-principal --id claude-code --tenant t1 --kind agent --name "Claude Code"
npm run admin -- grant --principal claude-code --bank bank-me --caps read,write
npm run admin -- issue-key --principal claude-code --label laptop   # prints the API key once
npm run admin -- set-extractor --bank bank-me --model anthropic:claude-opus-5-5   # optional: turn on fact extraction
npm start                                                            # http://localhost:8787
```

Recall uses the embedder named by `EMBEDDER` (default `openai:text-embedding-3-small`; `google:gemini-embedding-001` works too; `hashing` is the offline stand-in). After changing it run `npm run admin -- reindex --bank <id>`.

Extraction needs the provider's key in the environment (`ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_API_KEY`, or `OPENAI_COMPATIBLE_BASE_URL` for Ollama-style endpoints) and runs in a worker loop separate from indexing (`EXTRACTION_POLL_MS`, `LLM_TIMEOUT_MS`). Without `set-extractor`, a bank stores and recalls raw episodes only (the pgvector-only arm of the spike). Only the Subject's own turns are extracted from; assistant and tool output is context.

See `src/attachment/README.md` for the routes. Connect Claude Code to the same bank over MCP:

```bash
claude mcp add --transport http --scope user mem http://localhost:8787/v1/banks/bank-me/mcp --header "Authorization: Bearer <the key printed above>"
```

Domain code (`src/*/domain`) has no IO and is covered by fast unit tests. Infrastructure adapters are covered by contract tests against a real Postgres; `test/retrieval/retrieval-engine.contract.ts` is the contract every engine adapter (pgvector, Hindsight, Honcho) must pass.
