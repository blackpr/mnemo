# Two-week spike: Hindsight vs Honcho vs pgvector vs full context

Drafted 2026-10-23 from the research report `Self hosted AI memory layer landscape.md`. Goal of the spike is to pick (or reject) a memory engine for a self-hosted, provider-agnostic memory layer, using our own transcripts and an eval setup we control (an existing framework plus our own question set and grader prompt), instead of vendor benchmark numbers.

## 1. Question the spike must answer

> On our own conversations, does Hindsight or Honcho beat a plain pgvector store, and does either beat simply feeding the full history to the model, on accuracy, cost and latency, with the same answering model everywhere? And do they satisfy the governance minimum (scoped reads, verifiable deletion, provenance) we intend to build on top?

Decision at the end: **adopt one engine**, **adopt pgvector only and build extraction ourselves**, or **stop and reconsider**.

## 2. Hypotheses to confirm or kill

| # | Hypothesis | Source of the expectation | Kill criterion |
|---|---|---|---|
| H1 | Full context matches or beats every memory arm on accuracy at our history sizes | CoreDotToday full-context 80.7% LoCoMo; nine-week study ties at 3 weeks | A memory arm beats full context by more than the minimum detectable difference |
| H2 | Memory arms cost 5-10x fewer tokens per answer than full context | Mem0 ~7k tokens/retrieval vs 25k+ full; Anthropic context editing 84% cut | Token ratio under 3x |
| H3 | Write-path cost dominates total cost for extraction engines | Mem0 ~8.5k-token prompt per turn, ~10M tokens per 419-turn conversation | Write tokens under 30% of total |
| H4 | Specialized engines beat plain pgvector by less than the MDD on our data | Effloow: "default to pgvector" | Either engine beats pgvector by more than the MDD on accuracy |
| H5 | Neither engine gives verifiable deletion or complete provenance out of the box | HN "not part of a SaaS offering"; Mem0 delete_all issue | An engine passes all governance probes in section 6 |
| H6 | Extraction quality degrades on dates, state changes, sarcasm | HN OpenClaw report; HaluMem | Under 5% junk or wrong facts in the manual audit sample |

## 3. Arms

All four arms run through one existing eval framework (we build adapters, not a runner) with the **same answering model** and the **same grader model with the same published grader prompt**. Nothing else is comparable otherwise (grader prompt alone moved a LoCoMo score from 55.8% to 81.4%).

| Arm | What it is | Setup notes (verify against current docs on day 1) |
|---|---|---|
| A. Full context | Entire relevant history in the prompt, no retrieval | Pick a model with a large window; record exact token count per question |
| B. pgvector baseline | Postgres + pgvector, chunk raw turns, embed, top-k by cosine, no LLM extraction | One container, one table, one embedding model; this is the floor every engine must beat |
| C. Hindsight | `vectorize-io/hindsight`, MIT, v1.1.0 (2026-10-21). Postgres + pgvector. Four memory types, retain/recall/reflect, parallel semantic + BM25 + graph + temporal retrieval with rerank. 25+ providers incl. Anthropic, Gemini, Ollama. Per-bank MCP endpoint on by default. | Docker Compose or `pip install hindsight-api`. One bank per test user. Configure the extraction model explicitly and record it. Skip Helm for the spike. |
| D. Honcho | `plastic-labs/honcho`, AGPL-3.0, v3.4.0 (2026-10-22). Postgres + pgvector. Sync Storage API plus async "deriver" insights queue. Peers (humans and agents) first-class. Workspaces for tenancy. | `docker compose up`. **Auth is off by default**: set `AUTH_JWT_SECRET` before anything else. Defaults to OpenAI `gpt-5.4-mini`; repoint to our chosen extraction model via an OpenAI-compatible endpoint. Models must support tool calling. |

Use the same extraction model for C and D. Use the same embedding model for B, C and D where the engine allows it. Log every model name and version per arm.

**License note:** Honcho is AGPL. Fine for an internal spike; flag it before any decision to ship it inside a product.

## 4. Data: our own transcripts

Build one corpus, reused by all four arms.

**Sources to collect (week 1, day 1-2):**
- Claude Code: `~/.claude/projects/<project>/` session logs and the auto-memory folder (`MEMORY.md` plus memory files). Plain Markdown and JSONL, already local.
- Claude Desktop/claude.ai: chat export (ZIP/JSON). Memory itself cannot be exported structurally, so ask Claude to write out its memory as text and save that too.
- Gemini: Google Takeout chat export. Same trick for memory text.
- ChatGPT, if used: data export ZIP.
- Cursor / other coding agents: whatever local logs exist.

**Normalize** into one JSONL schema: `{conversation_id, source_tool, turn_index, role, timestamp, text}`. Keep raw files untouched beside it (provenance).

**Target size:** 20-40 conversations, mixed length, spanning at least three months of real dates, from at least two tools. Enough to compute a confidence interval; small enough to grade by hand where needed.

**Privacy:** this corpus is personal. Redact credentials and third-party personal data before ingesting into any engine. Keep everything on local machines or a box we control.

## 5. Question set

Write 150-250 questions over the corpus. Do not reuse LoCoMo (6-7% flawed answer keys and saturated). Categories, roughly equal weight:

1. **Single-hop fact recall** (what stack does project X use)
2. **Knowledge update / state change** (which option did we end up choosing after switching) — the category extraction engines fail most
3. **Point-in-time** (what did I believe about X in July) — needs bi-temporal validity
4. **Cross-tool** (fact stated in Gemini, asked in Claude Code) — the whole point of the layer
5. **Temporal ordering / dates** (what came first)
6. **Preference / instruction** (how do I like commits formatted)
7. **Abstention** (questions whose answer is not in the corpus; correct answer is "unknown") — catches confabulated memories

Each question: `{id, category, question, gold_answer, evidence_turn_ids, asked_at_date}`. Two people write, a third checks the keys with a strong model plus spot checks (under one cent per question).

## 6. Measurements

**Accuracy**
- LLM-graded correctness with a published grader prompt. Before trusting it, test the grader with deliberately wrong, hedged and near-date answers.
- Report per category and overall, with a 95% CI computed by clustering on conversation (not independent questions). Compute the minimum detectable difference up front; with ~200 questions expect something like 5-7 points. Differences smaller than that are noise.

**Cost** (per arm, per question, and total)
- Write tokens: all LLM input and output spent ingesting the corpus
- Read tokens: retrieval plus answer prompt per question
- Embedding tokens separately
- Convert to currency using our actual provider prices

**Latency**
- Ingest seconds per turn
- Retrieval p50 and p95
- End-to-end answer p50 and p95

**Store quality audit** (arms C and D)
- Sample 200 stored facts per engine. Hand-label each: correct, stale-but-marked, stale-unmarked, wrong, junk, duplicate. Reference for comparison: a Mem0 user audit found 97.8% junk in 10,134 entries.
- Inject 10 deliberate state changes mid-corpus, then query current state later (synthetic contradiction test).

**Governance probes** (arms C and D; pass/fail each)
- Scoped reads: create two users/banks/workspaces, try to read user A's memory with user B's credentials via every path, including direct GET by id.
- Deletion: delete one user's data, then search, GET by id, and inspect Postgres, embeddings, caches and queue tables. "Deleted" means zero hits everywhere.
- Provenance: for 20 facts, can we trace each to the source turn, the writer, and the extraction model version?
- Export: can we dump a user's memory to Markdown or JSONL with timestamps and sources without writing custom SQL?
- Poisoning: insert a turn containing an instruction-style injection and check whether it becomes a stored fact that later alters answers.
- Provider swap: switch extraction model from one provider to another (e.g. Claude to Gemini) and confirm the engine still runs. Note Honcho's tool-calling requirement.

## 7. Schedule

**Week 1: corpus, eval setup, baselines**

| Day | Work | Output |
|---|---|---|
| 1 | Collect and redact transcripts; normalize to JSONL. Read current Hindsight and Honcho docs; note anything that changed since 2026-10-23. | `corpus/` with raw and normalized data |
| 2 | Write question set (categories 1-7). Begin answer-key check. | `questions.jsonl` draft |
| 3 | Pick the eval framework (promptfoo for the TS stack, Inspect AI as the Python alternative; check current features, do not write a runner). Write the four arm adapters and the CI/MDD script. Pick and freeze answering model, grader model, grader prompt. | `eval/` runnable on arm A |
| 4 | Run arm A (full context). Run arm B (pgvector). Finish answer-key audit; drop or fix bad questions and log them. | Baseline results table |
| 5 | Grader sanity test (wrong, hedged, near-date). Compute MDD. Fix adapter bugs. Write day-5 note. | Frozen config, baseline numbers, MDD |

**Week 2: engines, audit, decision**

| Day | Work | Output |
|---|---|---|
| 6 | Stand up Hindsight (Compose). Configure extraction and embedding models. Ingest corpus into one bank per user. Record write tokens and ingest time. | Arm C ingested |
| 7 | Stand up Honcho (Compose, auth on). Repoint models. Ingest. | Arm D ingested |
| 8 | Run questions against C and D. Collect accuracy, read tokens, latency. | Four-arm results table |
| 9 | Store quality audit (200 facts each). Synthetic contradiction test. Governance probes. | Audit sheet, probe pass/fail grid |
| 10 | Write up. Fill the decision rubric. Record everything that was not tested. | `spike-results.md` and go/no-go |

Buffer: none. If an engine will not come up in half a day, document why and drop it. That is itself a finding about production readiness.

## 8. Decision rubric

Score each engine; pgvector and full context are the reference lines.

| Criterion | Weight | How scored |
|---|---|---|
| Accuracy vs full context (overall and on update + point-in-time categories) | high | Beats by more than MDD / within MDD / worse by more than MDD |
| Accuracy vs pgvector | high | Same three bands |
| Total cost per answered question incl. amortized write cost | high | Ratio to full context |
| Store quality: wrong + stale-unmarked + junk share | high | Under 5% / 5-20% / over 20% |
| Governance probes passed | high | Count of 6 |
| Provider swap worked | medium | Yes / with workarounds / no |
| Setup and ops friction (time to first ingest, docs accuracy, defaults safe) | medium | Hours and notes |
| License and project risk (AGPL, vendor control, age, release cadence) | medium | Notes |

**Default readings of the outcome:**
- Engine beats pgvector and full context on accuracy by more than MDD, cost well below full context, store quality acceptable: adopt it behind our own schema.
- Engine within MDD of pgvector on accuracy: adopt pgvector, write our own extraction and bi-temporal layer, revisit engines in six months.
- Full context beats everything and cost is tolerable at our history sizes: keep full context plus a thin index for now; the memory layer's job becomes provenance, deletion and portability only.
- Any engine fails scoped-read or deletion probes: do not put it in front of real user data without a gateway that enforces those itself.

## 9. Deliverables

- `corpus/` (raw + normalized, redacted)
- `questions.jsonl` with audit log of dropped or corrected keys
- `eval/` framework config, four arm adapters, CI/MDD script, with the frozen grader prompt committed
- `results/` per-arm JSON plus one summary table (accuracy with CI per category, tokens, latency)
- `audit/` fact-quality labels and governance probe grid
- `spike-results.md`: one page, decision first, then evidence, then "not tested"

## 10. Risks and what we will not learn

- Our corpus is tens of conversations, not millions of tokens. The spike cannot test the 1M-10M scale where memory engines widen their lead (BEAM-10M). Say so in the write-up.
- Two weeks of history, not nine weeks of drift. Tenure effects (curated memory decaying, provenance-typed graphs improving) will not show.
- Hindsight is under a year old and vendor-backed; Honcho's hosted tier may shape its roadmap. Neither risk is measurable in a spike. Mitigate by keeping the engine behind our own schema from day one.
- Docs may have moved since the research date. Day 1 includes re-reading them; do not trust this plan's setup notes over the current README.
- Gemini consumer app and ChatGPT free tier are not reachable via MCP, so the cross-tool category tests the data path, not live attachment to every client.

## 11. Open decisions before day 1

- Answering model and grader model (recommend two different models from different providers, so neither engine's default provider is also the judge).
- Extraction model for C and D (one shared choice; must support tool calling and structured output).
- Who owns the question set and who audits it.
- Where the corpus lives (one machine, encrypted volume).
