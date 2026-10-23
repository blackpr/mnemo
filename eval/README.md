# Eval

Runs `spike-plan-hindsight-vs-honcho.md`. **We do not build an eval framework.** promptfoo
(0.120.x, devDependency) runs the cases, calls the grader, caches model calls, and records tokens
and latency per result. This folder holds only what no framework can supply for us: the corpus
builder, the question set, the frozen grader prompt, one thin provider per arm, and a summarizer
that prints the plan's table.

```
eval/
  promptfooconfig.yaml   the run: two providers (arms), tests from questions/load.ts, grader pinned
  llm.ts                 the one model binding (answering model, grader ref, list prices)
  corpus/
    build.ts             ~/.claude/projects/*/*.jsonl -> normalized/<conversationId>.jsonl + index.json
    normalize.ts         pure: keep human turns + assistant text, drop tool traffic, redact, merge, truncate
    store.ts             read side (index, conversations, turn rendering shared by drafter and arms)
    normalized/, index.json   (gitignored) the corpus itself
  questions/
    schema.ts            zod schema {id, conversationId, question, answerKey, asOf?, type, audited}
    draft.ts             drafts candidates with the answering model; writes audited: false
    load.ts              promptfoo test generator (one llm-rubric per question; EVAL_* env filters)
    questions.jsonl      the set (committed; audit marks live here)
    answer-key-log.md    every drop or correction, with reason
  grader/
    grader-prompt.txt    the frozen grader prompt (committed; do not edit without a log entry)
    sanity.yaml          wrong / hedged / near-miss / abstention cases; check-sanity.ts checks verdicts
  arms/
    lib.ts               answering call (promptfoo cache), REST client, admin runner, result shape
    ingestion.ts         shared by B, C, D: ingestion record under results/, one ingestion at a time
    full-context.ts      arm A: whole conversation in the prompt, prompt tokens recorded
    pgvector.ts          arm B: retain through REST into eval-<id8>, drain, recall, answer
    hindsight.ts         arm C: Hindsight natively (its own extraction, recall), official TS client
    honcho.ts            arm D: Honcho natively (deriver, representation + message search), official SDK
  stats/
    rows.ts              the slice of a promptfoo results file the two scripts read
    summarize.ts         promptfoo results -> the section 6 table as Markdown
    ci.ts                cluster-robust 95% CI by conversation, paired differences, MDD
  results/               (gitignored) promptfoo output and the three ingestion records
  RESULTS.md             latest table with its label (smoke run or decision run)
```

```bash
npm run eval:build-corpus        # prints stats only; excludes this repo's own sessions
npm run eval:draft-questions     # once; refuses to overwrite questions.jsonl without --force
npm run eval:grader-sanity       # must end with "all 9 verdicts as expected"
EVAL_MAX_CONVERSATIONS=5 EVAL_MAX_QUESTIONS=20 EVAL_MAX_PER_CONVERSATION=5 npm run eval:run   # smoke
npm run engines:up               # arms C and D: Hindsight and Honcho containers (docker-compose profiles)
npm run engines:honcho:admin-jwt # once: Honcho's admin token, put it in .env as HONCHO_API_KEY
npm run eval:run                 # everything (add EVAL_REQUIRE_AUDITED=1 for the decision run)
npm run eval:summary             # table from eval/results/latest.json (several files: -- a.json b.json)
npm run eval:ci                  # cluster-robust CI by conversation, paired differences and MDD
npm run eval:view                # promptfoo's browser UI over past runs
```

Needs: the server (`npm start`, :8787), `MEM_API_KEY` in `.env` for principal `eval-runner`
(tenant `t-eval`; `admin create-principal` + `issue-key`), provider keys in `.env`, and for arms C
and D the engine containers plus `HINDSIGHT_BASE_URL` / `HINDSIGHT_API_KEY` / `HONCHO_BASE_URL` /
`HONCHO_API_KEY` (see `.env.example`).

Arms C and D run the engines natively, not through our `RetrievalEngine` adapters: a Hindsight bank
or Honcho workspace `eval-<id8>` per conversation, the engine's own extraction and its own retrieval,
answered by the same pinned model from the recalled material. Extraction models come from
`docker-compose.yml`: Hindsight runs Opus 5.5 like arm B; Honcho runs **claude-sonnet-4-5** because
Honcho 3.4.1 cannot drive a Claude 5 model (see the compose comment and `research_notes/honcho-2026-10-23.md`),
so the write side of D is not like-for-like; every row records `extractionModel` and the table prints it. That is what the plan compares; the adapters
(`src/retrieval/infrastructure/{hindsight,honcho}`) are the other deliverable, the engines behind
our port, and are proven by the contract tests, not by the eval. Arm C's material is Hindsight's
`recall` results (bounded by `EVAL_RECALL_MAX_TOKENS`, default 4096, since it has no count limit);
arm D's is the user peer's `representation` focused by the question plus a session message search
(`EVAL_RECALL_LIMIT`). Honcho's dialectic `chat` is not used for scoring (it answers with its own
prompt and model). Write tokens: Hindsight reports usage per retain and keeps an LLM trace that
also covers its background consolidation (the table uses the trace total); Honcho reports nothing
per request, so arm D reads the deriver's Prometheus counter deltas (process-wide, hence one
ingestion at a time). Ingestion records: `results/hindsight-banks.json`, `results/honcho-workspaces.json`.

Arm B variants: by default the bank extracts with the answering model, so recall returns facts and
episodes (the "pgvector plus our extraction" arm the stage 1 task asked for). `EVAL_B_EXTRACTOR=none`
is the plan's floor, raw turns embedded with no LLM extraction: separate `eval-<id8>-raw` banks,
episodes only, metadata `arm: B-pgvector-raw` (the summary groups by that name). Run the two as
separate evals into separate files, since the npm script writes `results/latest.json`:
`EVAL_B_EXTRACTOR=none npm run eval:run -- -o eval/results/raw.json` (promptfoo takes the last `-o`)
and `npm run eval:summary -- eval/results/raw.json`.
A bank id is never reused for other content: the ingestion record (`results/pgvector-banks.json`)
carries a digest of the conversation and the arm refuses a mismatch; erase the bank
(`admin erase-bank`), delete its entry, run again.

Rules:
- Same answering model and same grader model for every arm (`llm.ts`, `promptfooconfig.yaml`); model refs recorded in every result's metadata.
- Corpus is frozen after day 2; dropped or corrected questions are logged, never silently removed.
- Arm B only ever writes to banks named `eval-*`; `bank-demo` is never touched.
- Nothing here is imported by `src/`. (`eval/` imports `looksLikeSecret` from `src/`, the other direction.)
- Keys come from `.env` through the npm scripts; nothing under `eval/` prints or stores one.
- Privacy: the raw transcripts are read in place under `~/.claude/projects` (the plan's "raw beside
  normalized" provenance is the original files); the normalized corpus is gitignored; but
  `questions/questions.jsonl` is committed and quotes facts from the user's own conversations
  (project names, decisions). That is deliberate for a private repository and must be revisited
  before this repository is ever made public. promptfoo also keeps every result (question, rubric
  with answer key, recalled transcript material, answers) in `~/.promptfoo/promptfoo.db` and the
  model calls in `~/.promptfoo/cache`; `eval:view` serves them on localhost only.

Caching: the grader is cached by promptfoo's Anthropic provider; the arms' answering calls are cached
in the same store through `context.getCache` (key: arm, model, system prompt, material, question), so
a rerun over unchanged questions and unchanged recalled material re-spends nothing and the summary
reports `cached` rows. Turn it off with `PROMPTFOO_CACHE_ENABLED=false` (the `--no-cache` flag does
not reach the arms). Arm B ingestion is recorded in `results/pgvector-banks.json` and skipped on rerun.

Statistics: promptfoo reports no interval, so `eval:ci` computes the plan's cluster-robust 95% CI
(conversations as clusters, Liang-Zeger sandwich with the G/(G-1) correction and t with G-1 degrees
of freedom), a cluster bootstrap beside it, and for every pair of arms the paired difference, whether
its interval excludes zero, and its minimum detectable difference at 80% power. The MDD is
retrospective (computed from the observed spread, not the up-front number the plan wanted for a
200-question set): it says what this design could have detected, and a difference below it is noise
unless its interval excludes zero. With four conversations t is 3.18 and the intervals are wide; that
width is the finding, not a bug. Estimators are in `stats/cluster.ts` with unit tests; several result
files can be passed and duplicate (arm, question) rows are skipped.

Questions: all 40 are `audited: true, auditedBy: "model"` since stage 2 (a model re-read every
conversation; 3 keys corrected, 2 questions reworded, 0 dropped; `answer-key-log.md`), so
`EVAL_REQUIRE_AUDITED=1` now admits every question. The plan's human audit is still open;
`auditedBy: "human"` is reserved for it and `EVAL_REQUIRE_AUDITED=human` selects only those. The drafted type balance is
uneven (fact 18, decision 9, temporal 5, preference 4, negative 4) and is reported per type.

## Resuming an interrupted run

A run that dies half-way (the 2026-10-23 stage 2 run did, when the Anthropic account ran out of
credit) is resumed with the same command once the cause is fixed, with the server (`npm start`)
and the engines (`npm run engines:up`) running:

```bash
EVAL_REQUIRE_AUDITED=1 npm run eval:run
```

Everything already done is reused: answers and grades of completed rows come from promptfoo's
cache, arm B's banks and arm C's and D's recorded banks and workspaces are skipped, arm C resumes a
Hindsight bank that exists without a record (Hindsight skips unchanged documents), and only the
missing ingestions and rows spend money. Arm D refuses a workspace that exists without a record
(messages have no idempotency key); delete its session and workspace as the error says. promptfoo
records a provider failure as a row with `error`; `eval:summary` and `eval:ci` exclude such rows and
print them as "not run". If Hindsight's `pending_consolidation` stops moving (an in-flight operation
is orphaned when its container is replaced), cancel the operation and re-trigger consolidation via
its API (`research_notes/hindsight-2026-10-23.md`).

Known limits of the harness as of stage 2: promptfoo's `not-llm-rubric`
does not invert model-graded assertions, hence `check-sanity.ts`; promptfoo's built-in Anthropic
provider only omits `temperature` (rejected by the API for this model) when `thinking` is configured,
which the configs do; importing `cache` from the `promptfoo` package inside a provider gives a second
cache instance that fights the evaluator's over `cache.json` (use `context.getCache`); the write-token
ledger (`extraction.runs`) keeps only the last attempt's usage per run, so retried extractions
under-report write cost; `build.ts` excludes this checkout's own project folder, not other worktrees
or clones of this repository.
