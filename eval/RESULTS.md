# Eval results

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
