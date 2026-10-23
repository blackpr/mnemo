# Spike results: Hindsight vs Honcho vs pgvector vs full context

Written 2026-10-24 at the end of stage 2 of `spike-plan-hindsight-vs-honcho.md`. The decision run
is complete at the corpus size we have: four arms, 40 model-audited questions, 4 Claude Code
conversations (121 turns, 29k tokens). The full table, intervals and caveats are in
`eval/RESULTS.md`; the engine facts in `research_notes/hindsight-2026-10-23.md` and
`research_notes/honcho-2026-10-23.md`.

## Decision

**Adopt pgvector and keep building extraction and the bi-temporal layer ourselves; keep both
engines behind the port (adapters committed and contract-tested) and do not put either in front of
real user data without a gateway.** This is the plan's second default reading ("engine within MDD
of pgvector"): on accuracy the arms are indistinguishable (A 40/40, B 39/40, C 40/40, D 40/40;
every paired difference within the 10.4-point MDD, no interval excludes zero), so the decision rests
on what the spike could measure, where both engines lose to pgvector on this data:

- Write cost (H3 holds): Hindsight spent 1.96M LLM tokens, about 11.4 USD at list, to ingest 29k
  tokens of transcripts (about 68 tokens of LLM work per corpus token, 55% of it in background
  consolidation); arm B spent 476k tokens, 2.2 USD, for the same turns; Honcho's counters say 103k
  tokens, but on a cheaper model it was forced onto and with part of its work uncounted.
- Read side (H2 not met): B reads 3.0x fewer tokens than full context, D 2.2x, C 1.4x; retrieval
  p50 0.27 s for B and D, 1.36 s for C (p95 4.8 s).
- Governance: Hindsight's bank delete leaves the LLM trace, full prompts included, in its database;
  Honcho's deletion is asynchronous and its API reports failed deriver work as completed. Neither
  offers point-in-time validity, a per-item hard delete or an embedder filter; both sit behind the
  port only through metadata workarounds (gap list below).
- Provider independence: Honcho 3.4.1 cannot run a Claude 5 model at all.

What would change it: a larger, multi-tool corpus with many update and point-in-time questions
(plan sections 5 and 10) on which Hindsight's observations or Honcho's representation beat pgvector
plus our extraction by more than the MDD; or Hindsight's write cost falling by an order of magnitude
(consolidation off, cheaper model). The one question pgvector missed is of exactly that kind (a
decision that changed within the conversation), and both engines got it right; one question is not
a finding, but it is the question to grow.

## Evidence: section 6 table

Same answering model (claude-opus-5-5) and grader everywhere. Extraction: B and C claude-opus-5-5;
D claude-sonnet-4-5 (forced; the write side is uneven, see findings). Embedder
text-embedding-3-small in B, C, D. Write columns cover all four banks per arm.

| Measure | A-full-context | B-pgvector | C-hindsight | D-honcho |
| --- | --- | --- | --- | --- |
| Accuracy, overall (40 questions) | 100% | 97.5% (39/40) | 100% | 100% |
| Accuracy by type (decision 9 / fact 18 / negative 4 / preference 4 / temporal 5) | all 100% | 89% / 100% / 100% / 100% / 100% | all 100% | all 100% |
| Cluster-robust 95% CI, overall (G = 4) | [100, 100] | [89.5, 100] | [100, 100] | [100, 100] |
| Read tokens per question (prompt, mean) | 11,600 | 3,833 | 8,246 | 5,189 |
| Write tokens, total (4 banks) | 0 | 476,248 | 1,964,373 (394 LLM calls, 564k cached) | 102,633 (deriver counters) |
| Retrieval latency p50 / p95 (ms) | n/a | 274 / 356 | 1359 / 4805 | 263 / 484 |
| End-to-end latency p50 / p95 (ms, uncached) | 2895 / 4492 | 3093 / 4969 | 4997 / 9835 | 3198 / 4483 |
| Ingest seconds per turn | n/a | 2.5 | 18.2 | 2.9 |
| Read cost, total (USD, list) | 1.98 | 0.74 | 1.47 | 0.97 |
| Write cost, total (USD, list Opus prices) | 0 | 2.20 | 11.43 (about 9.5 with cache reads at the cached rate) | 0.74 (0.55 at Sonnet 4.5 prices) |
| Total per answered question incl. write (USD, list) | 0.049 | 0.073 | 0.323 | 0.043 |

**Confidence interval and minimum detectable difference** (`npm run eval:ci`): conversations are
the clusters (G = 4, t = 3.18). Paired differences: A−B 2.5 points [−5.5, 10.5], B−C and B−D −2.5
[−10.5, 5.5], the rest 0; MDD at 80% power 10.4 points; nothing significant. The plan's 5-7 point
target needs its 150-250 question set over 20-40 conversations.

## Engine gap list (port `RetrievalEngine` vs what each engine offers)

| Port need | Hindsight 1.1.0 | Honcho 3.4.1 |
| --- | --- | --- |
| Index an already extracted fact without an LLM | No: `verbatim` mode still makes one LLM call per item (entities, dates) | Yes, as a message in a session with `observe_me: false` and summaries off |
| Our ids back on hits | Yes, via `metadata` and `document_id` | Yes, via message metadata |
| Point-in-time `asOf` | None (`temporal_window` ranks, does not filter); filtered in the adapter after over-fetching a token budget | None on search/representation/chat; `created_at <= asOf`, the retraction flag and the facts session pushed into search, `validTo` filtered in the adapter |
| Retract one fact | Soft invalidate (`PATCH state=invalidated`), no hard delete | No message delete; metadata flag plus adapter filter |
| Re-index with new validity | Identical text under the same document id is skipped by content hash after `replace` dropped its units; adapter versions document ids and never re-retains an existing version | Metadata update on the existing message |
| Purge a bank with proof of zero | Bank delete removes memories/documents/chunks/entities (verified in its Postgres) but **not `llm_requests`** (full prompts; retention default 1 day) | Asynchronous (202 + deriver job); verified clean in its Postgres when the API stops listing; adapter polls with raw reads |
| Embedder id filter | Not expressible (engine owns its embedder) | Not expressible (dimensions immutable per deployment) |
| Scores | `scores.final` | None (RRF order); adapter uses 1/rank |
| Provider swap to Claude 5 | Works (Opus 5.5 extraction) | **Fails** (prefill, then thinking type); Claude 4.5 works |
| Write-token reporting | Per retain `usage` plus a per-bank LLM trace (covers consolidation) | Nothing in responses; deriver Prometheus counters only (process-wide) |
| Failure reporting | Operations have status; an in-flight consolidation is orphaned by a container restart and must be cancelled by hand | Deriver reports failed LLM calls as completed work units |
| Isolation | Banks isolated; one server API key (tenant extension point) | Workspaces; JWT admin token (named scopes exist, not tried) |
| Ops | 3.7 GB image, embedded Postgres, auth off by default | Four containers (API, deriver, Postgres, Redis); auth off by default; in-process cache serves deleted workspaces unless Redis is on |
| License | MIT | AGPL-3.0 |

## Rubric (plan section 8)

| Criterion | Hindsight | Honcho |
| --- | --- | --- |
| Accuracy vs full context (overall; update + point-in-time) | within MDD (40/40 vs 40/40) | within MDD (same) |
| Accuracy vs pgvector | within MDD (+2.5, interval includes 0) | within MDD (same) |
| Total cost per answered question incl. amortized write | 6.6x full context, 4.4x pgvector | 0.9x full context on a cheaper extractor; not comparable |
| Store quality (wrong + stale + junk share) | not audited (observations looked on-topic in recall material) | not audited (467 conclusions for 121 turns; spot checks correct) |
| Governance probes passed (of 6) | deletion: fails on the LLM trace; others not run | deletion: passes via API and DB after polling; others not run |
| Provider swap | yes (Opus 5.5) | no for Claude 5, yes for Claude 4.5 |
| Setup and ops friction | under an hour to first ingest; stale README compose path; auth off by default; orphaned consolidation after a restart; 18 s per turn to ingest | about two hours including the cache and prefill defects; auth off by default; deriver is a separate process; 3 s per turn |
| License and project risk | MIT, under a year old, vendor-backed, weekly releases | AGPL, three years old, hosted tier |

## What four conversations can and cannot decide

Can: whether an engine comes up, what it costs to ingest real transcripts, whether its deletion and
provider story holds, whether it confabulates on questions with no answer (none did), and whether
it fails outright on this kind of data (none did). Cannot: any accuracy ranking. All four arms are
at or near the ceiling, the MDD is 10 points, and the update, point-in-time and cross-tool
categories the engines are supposed to win are one or two questions per conversation drawn from
one tool over two weeks.

## Not tested

Store quality audit (200 facts per engine), synthetic contradiction injection, scoped-read and
poisoning probes, export and provenance probes beyond what the adapters needed, arm B without
extraction (`EVAL_B_EXTRACTOR=none`), Honcho's dialectic `chat` as an answering path, the human
audit of the question set (a model audited it), growth of the corpus to claude.ai and Gemini exports.

## Spend

Stage 2 cost about 19 USD at list prices (about 17 as billed, Hindsight's cache reads at the cached
rate), over the 15 USD target: Hindsight ingestion 11.9, promptfoo passes 5.9 (one interrupted by an
exhausted API account and resumed from caches), Honcho 0.8, probes and contract runs 0.6. Stage 1
cost about 5.8. The overrun is Hindsight's consolidation of the 64-turn conversation, which the
12-turn smoke bank had not predicted linearly.
