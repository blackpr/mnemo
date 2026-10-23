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
    full-context.ts      arm A: whole conversation in the prompt, prompt tokens recorded
    pgvector.ts          arm B: retain through REST into eval-<id8>, drain, recall, answer
    (hindsight.ts, honcho.ts: stage 2)
  stats/summarize.ts     promptfoo results -> the section 6 table as Markdown
  results/               (gitignored) promptfoo output, pgvector-banks.json ingestion record
  RESULTS.md             latest table with its label (smoke run or decision run)
```

```bash
npm run eval:build-corpus        # prints stats only; excludes this repo's own sessions
npm run eval:draft-questions     # once; refuses to overwrite questions.jsonl without --force
npm run eval:grader-sanity       # must end with "all 9 verdicts as expected"
EVAL_MAX_CONVERSATIONS=5 EVAL_MAX_QUESTIONS=20 EVAL_MAX_PER_CONVERSATION=5 npm run eval:run   # smoke
npm run eval:run                 # everything (add EVAL_REQUIRE_AUDITED=1 for the decision run)
npm run eval:summary             # table from eval/results/latest.json
npm run eval:view                # promptfoo's browser UI over past runs
```

Needs: the server (`npm start`, :8787), `MEM_API_KEY` in `.env` for principal `eval-runner`
(tenant `t-eval`; `admin create-principal` + `issue-key`), provider keys in `.env`.

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

Known limits of the harness as of stage 1: the cluster-robust CI and minimum detectable difference
from the plan are not computed yet (not meaningful at smoke size); promptfoo's `not-llm-rubric`
does not invert model-graded assertions, hence `check-sanity.ts`; promptfoo's built-in Anthropic
provider only omits `temperature` (rejected by the API for this model) when `thinking` is configured,
which the configs do; importing `cache` from the `promptfoo` package inside a provider gives a second
cache instance that fights the evaluator's over `cache.json` (use `context.getCache`); the write-token
ledger (`extraction.runs`) keeps only the last attempt's usage per run, so retried extractions
under-report write cost; `build.ts` excludes this checkout's own project folder, not other worktrees
or clones of this repository.
