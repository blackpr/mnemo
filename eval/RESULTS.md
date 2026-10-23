# Eval results

## Stage 2 decision run, 2026-10-23/24: four arms, 40 audited questions, 4 conversations

**This is the stage 2 run the plan asked for, at the corpus size we have.** It is complete (every
arm answered all 40 questions) but small: four Claude Code conversations, one tool, 29k tokens, so
the minimum detectable difference is about 10 points and nothing below that is a finding. The run
was interrupted once by an exhausted API account and resumed from caches and ingestion records
(`eval/README.md`, "Resuming an interrupted run"); the completed rows were reused.

Setup: corpus as in stage 1 (121 turns; claude.ai and Gemini exports are out of scope for this
session, they need the user's data). Answering model `anthropic:claude-opus-5-5` in all four arms;
grader `anthropic:claude-opus-5-5` with the frozen `grader/grader-prompt.txt`. Arm B: extractor
claude-opus-5-5, embedder text-embedding-3-small, recall limit 10 with episodes, `asOf` passed for
temporal questions. Arm C: Hindsight 1.1.0 as shipped (concise extraction, observations on, all
four retrieval arms, reranking), extraction model claude-opus-5-5, embedder text-embedding-3-small,
recall bounded by 4096 tokens, `query_timestamp` for temporal questions. Arm D: Honcho 3.4.1 as
shipped (deriver on for both peers, summaries on), **extraction model claude-sonnet-4-5** because
Honcho cannot drive a Claude 5 model (below), embedder text-embedding-3-small, material = user
peer's representation focused by the question plus a 10-message session search. **The write side is
uneven**: B and C extract with Opus 5.5, D with Sonnet 4.5; the read side (answering model, grader)
is identical everywhere.

Table (`npm run eval:summary` over `results/latest.json`):

| Measure | A-full-context | B-pgvector | C-hindsight | D-honcho |
| --- | --- | --- | --- | --- |
| Questions answered | 40 | 40 | 40 | 40 |
| Answers served from cache (from the interrupted first pass) | 11 | 11 | 10 | 10 |
| Extraction model (write path) | none | claude-opus-5-5 | claude-opus-5-5 | claude-sonnet-4-5 |
| Accuracy, overall | 100% (40/40) | 98% (39/40) | 100% (40/40) | 100% (40/40) |
| Accuracy, decision | 100% (9/9) | 89% (8/9) | 100% (9/9) | 100% (9/9) |
| Accuracy, fact | 100% (18/18) | 100% (18/18) | 100% (18/18) | 100% (18/18) |
| Accuracy, negative | 100% (4/4) | 100% (4/4) | 100% (4/4) | 100% (4/4) |
| Accuracy, preference | 100% (4/4) | 100% (4/4) | 100% (4/4) | 100% (4/4) |
| Accuracy, temporal | 100% (5/5) | 100% (5/5) | 100% (5/5) | 100% (5/5) |
| Read tokens per question (prompt, mean, nominal) | 11,600 | 3,833 | 8,246 | 5,189 |
| Read tokens, total (prompt + completion, nominal) | 470,077 | 159,705 | 337,362 | 214,422 |
| Write tokens, total (extraction, 4 banks) | 0 (no write path) | 476,248 | 1,964,373 | 102,633 (deriver counters) |
| Write LLM calls / prompt-cached tokens (where the engine reports them) | not reported | not reported | 394 / 564,494 | not reported |
| Embedding tokens, total (where metered) | not metered | not metered | 109,042 | not metered |
| Grader tokens, total | 32,228 | 32,445 | 33,662 | 32,470 |
| Answer latency p50 / p95 (ms, uncached) | 2895 / 4492 | 2834 / 4701 | 2922 / 4750 | 2924 / 4220 |
| Retrieval latency p50 / p95 (ms) | n/a | 274 / 356 | 1359 / 4805 | 263 / 484 |
| End-to-end latency p50 / p95 (ms, uncached) | 2895 / 4492 | 3093 / 4969 | 4997 / 9835 | 3198 / 4483 |
| Ingest seconds per turn (mean) | n/a | 2.5 | 18.2 | 2.9 |
| Read cost, total (USD, nominal; cache hits included) | $1.978 | $0.741 | $1.470 | $0.968 |
| Write cost, total (USD, list, Opus prices) | $0.000 | $2.196 | $11.434 (about $9.5 with Hindsight's cache reads at the cached rate) | $0.735 (at Sonnet 4.5 prices: $0.55) |
| Grader cost, total (USD, uncached calls only) | $0.138 | $0.137 | $0.152 | $0.142 |

Notes on the write column: arm C's number is the bank's whole LLM trace, retain plus background
consolidation into observations, including the consolidation work Hindsight redid after an
in-flight operation was orphaned by a container restart and recovered through its API (bank
`eval-696cce29`: 303 LLM calls, 1.09M input tokens for 64 turns). Arm D's number is what Honcho's
deriver counters publish, which exclude the `previous_summary` input component for one conversation
(the parser now counts it; the 3,566 summary input tokens of `3a6c5eae` are therefore a slight
under-count) and do not cover the API process's own LLM use.

Confidence intervals and MDD (`npm run eval:ci`, conversations as clusters, G = 4, t = 3.18):
A, C and D have no variance (40/40 each). B overall 97.5% with a cluster-robust 95% interval of
[89.5, 100]; B decision 88.9% [56.8, 100]. Every paired difference is within the retrospective MDD
of 10.4 points and no interval excludes zero (A−B 2.5 [−5.5, 10.5]; B−C and B−D −2.5 [−10.5, 5.5];
A−C, A−D, C−D 0). Nothing here separates the arms on accuracy.

The one miss: `B-pgvector` on `3a6c5eae-01` (decision), the question flagged in stage 1 and
corrected in the audit. The key says every "If asked" answer was removed from SAY.md; arm B's
recall (10 facts and episodes) surfaced the earlier state and one removal, not the final removal
turn, and the answer described SAY.md as still holding them. Full context, Hindsight and Honcho all
answered it from the final state.

Reading, with the MDD in mind:
- Accuracy saturates at this size for every arm, including the negative questions (no arm
  confabulated). H1 (full context matches or beats memory arms) holds trivially; H4 (engines beat
  pgvector by less than the MDD) holds: 2.5 points on one decision question.
- H2 (memory arms read 5-10x fewer tokens than full context): B reads 3.0x fewer, D 2.2x, C only
  1.4x (Hindsight's recall is bounded by a token budget, not a count, and returns observations
  alongside facts). Not met; the conversations are short.
- H3 (write cost dominates for extracting arms): emphatically for C ($11.4 write vs $1.5 read),
  yes for B ($2.2 vs $0.7); D looks cheap because it ran a cheaper model and its counters miss part
  of the work. Per transcript token, Hindsight spent about 68 LLM tokens per corpus token.
- Latency: retrieval p50 is 0.26-0.27 s for B and D and 1.36 s for C (p95 4.8 s); answering
  dominates everywhere.

Findings from standing the engines up (details in `research_notes/hindsight-2026-10-23.md` and
`research_notes/honcho-2026-10-23.md`):
- **Honcho 3.4.1 cannot drive Claude 5 models.** Its Anthropic backend prefills an assistant `{`
  for JSON output (Claude 5 rejects prefill, HTTP 400); a thinking budget switches the prefill off
  but then it sends `thinking.type=enabled`, which Claude 5 also rejects, and the operator
  passthrough cannot replace that typed argument. Its model check exempts only Claude 4-class names.
  The deriver reports the failed work units as completed (zero conclusions, queue says done). Arm D
  therefore runs on claude-sonnet-4-5. Provider swap, in the rubric's terms: works for Claude 4.5,
  fails for Claude 5.
- **Hindsight's bank delete leaves its LLM trace.** `DELETE /v1/default/banks/{id}` removes memory
  units, documents, chunks, entities and the bank row (checked in its embedded Postgres), but the
  per-bank `llm_requests` rows, which hold the full extraction prompts with the subject's text, stay
  until the trace retention expires (default 1 day). The adapter's `purgeBank` cannot see them. For
  our erasure guarantee that means: trace off in production, or the receipt covers memories only.
- Hindsight orphans an in-flight consolidation when its container is replaced (new worker id); the
  queue then never drains until the operation is cancelled and consolidation re-triggered via API.
- Honcho with `CACHE_ENABLED=false` still caches workspaces in-process; the deriver's deletions never
  invalidate it, so a deleted workspace name answers 409 for up to five minutes. Redis fixes it.
- Hindsight's `verbatim` mode (used by our port adapter) still makes one LLM call per item.
- Neither engine has a point-in-time filter, a per-item hard delete (Hindsight: soft invalidate;
  Honcho: none for messages), or a way to express our embedder id.

Spend for stage 2 (list prices unless noted): **about 19 USD at list, about 17 USD as billed**,
over the 15 USD target. Hindsight ingestion of the four banks 11.9 at list (9.8 with its 564k
cache-read tokens at the cached rate), the promptfoo runs 5.9 (two smoke passes 0.25, the
interrupted first pass 1.0, the completed pass 4.6), Honcho on Sonnet 4.5 about 0.8 including the
ingestions the outage wasted, probes and three Hindsight contract runs about 0.6. The estimate
before resuming was 14 at list; the overrun is Hindsight's consolidation of the 64-turn
conversation (545 trace calls on that bank, part of it the re-run after the orphaned operation),
which the 12-turn smoke bank had not predicted linearly.

Not done in this session: the store quality audit, the governance probe grid (scoped reads with two
credentials, poisoning, provenance, export), the synthetic contradiction test, the arm B floor
without extraction, Honcho's dialectic `chat` as an answering path, the human audit of the question
set (model audit only), corpus growth.

## Smoke run, 2026-10-23 (stage 1: arms A and B only)

**This is a smoke run of the harness, not the decision.** Four conversations, 20 questions, none
audited, one source tool, no confidence interval. It shows that the pipeline works end to end and
what the numbers look like at this size; the decision rubric in the plan (section 8) needs the
stage 2 run (audited questions, larger corpus from two tools, arms C and D, CI/MDD).

Setup: corpus of 4 Claude Code conversations (121 turns, about 29k tokens, 2026-10-03 to
2026-10-16; this repository's own sessions excluded). 40 questions drafted by the answering model,
20 selected (5 per conversation, one of each type first). Answering model `anthropic:claude-opus-5-5`
in both arms; grader `anthropic:claude-opus-5-5` with `grader/grader-prompt.txt` (9/9 sanity verdicts
as expected). Arm B: one `eval-*` bank per conversation, extractor `anthropic:claude-opus-5-5`,
embedder `openai:text-embedding-3-small`, recall limit 10 with episodes, `asOf` passed for temporal
questions. Arm A: every turn in the prompt; for temporal questions the as-of instant is stated in
the instruction only.

Table from the plan's section 6 (`npm run eval:summary` over `results/latest.json`):

| Measure | A-full-context | B-pgvector |
| --- | --- | --- |
| Questions | 20 | 20 |
| Answers served from cache | 1 | 0 |
| Accuracy, overall | 100% (20/20) | 90% (18/20) |
| Accuracy, decision | 100% (4/4) | 75% (3/4) |
| Accuracy, fact | 100% (4/4) | 100% (4/4) |
| Accuracy, negative | 100% (4/4) | 100% (4/4) |
| Accuracy, preference | 100% (4/4) | 100% (4/4) |
| Accuracy, temporal | 100% (4/4) | 75% (3/4) |
| Read tokens per question (prompt, mean, nominal) | 11,603 | 4,030 |
| Read tokens, total (prompt + completion, nominal) | 235,092 | 83,857 |
| Write tokens, total (extraction, per bank once) | 0 (no write path) | 476,248 |
| Grader tokens, total | 16,416 | 16,769 |
| Answer latency p50 / p95 (ms, uncached) | 2838 / 4937 | 2959 / 4102 |
| Retrieval latency p50 / p95 (ms) | n/a | 296 / 485 |
| End-to-end latency p50 / p95 (ms, uncached) | 2838 / 4937 | 3290 / 4398 |
| Ingest seconds per turn (mean) | n/a | 2.5 |
| Read cost, total (USD, nominal; cache hits included) | $0.989 | $0.388 |
| Write cost, total (USD) | $0.000 | $2.196 |
| Grader cost, total (USD, uncached calls only) | $0.096 | $0.107 |

Prices: $4 per million input tokens, $20 per million output (claude-opus-5-5 list price). Embedding
tokens are not metered by the REST attachment; at this size they are well under one cent.

What the smoke run says, with the caveat that 20 questions cannot separate the arms:
- Both arms abstained correctly on all four negative questions; neither confabulated.
- Arm B's two misses are one temporal and one decision question. The decision question
  (`3a6c5eae-01`) also failed in an earlier pass of arm A and is flagged in
  `questions/answer-key-log.md`: the conversation changes its mind, so the key may be wrong.
- Read tokens per question: arm B uses about 2.9x fewer than full context (H2 wants 5-10x; the
  conversations here are short, so full context is cheap).
- Write cost dominates arm B's total (H3): 476k extraction tokens for 61 user turns, about 7.5k
  input tokens per extracted turn, since each extraction prompt carries the bank's current facts.
  At this corpus size arm B costs about 2.6x arm A in total ($2.59 vs $0.99) and would need many
  more reads over the same history to amortize.
- Retrieval is fast (p50 about 0.3 s); answer generation dominates latency in both arms.

Spend for all of stage 1 (from token usage in the result files, Opus 5.5 list prices): about $5.8.
Question drafting $0.34, extraction of the 4 eval banks $2.20, two full smoke passes $1.37 + $1.36
read and $0.21 + $0.20 grading, cache verification $0.05, grader sanity about $0.05. The target was
about $5; the overrun is the second smoke pass, run to include the negative category, which
re-spent its answering calls because the arms were using a separate promptfoo cache instance
(fixed: the arms now use the evaluator's `context.getCache`, verified by a fully cached rerun).

Not measured here: the plan's arm B floor without LLM extraction (`EVAL_B_EXTRACTOR=none`, implemented, not run), store quality audit, governance probes, provider swap (plan section 6; stage 2).
