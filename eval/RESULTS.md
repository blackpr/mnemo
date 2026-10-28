# Eval results

## Extraction cost, 2026-10-24/28: where arm B's write tokens go, and the cheaper extractor

### Before: the `extract-v2` prompt on the LoCoMo subset

Measured from the four `eval-locomo*` banks' `extraction.runs` ledgers as recorded in
`eval/results/locomo-ab.json` (the banks themselves are erased), and decomposed by rebuilding every
one of the 114 prompts offline with `buildExtractionUserPrompt` over the committed corpus (the facts
block is an estimate: about 12 facts asserted per session chunk, 95 characters each, capped at the
extractor's 200; the dev ledger for `bank-demo` averages 4,051 input tokens over 9 runs with the
same shape). The rebuilt prompts come to 1.38M characters/4; the ledger says 2.25M tokens, so
LoCoMo's dialogue tokenizes at about 2.5 characters per token and the shares below are what matter.

| Part of one extraction call (mean per episode, 114 episodes) | Share of input | Tokens (ledger-scaled) |
| --- | --- | --- |
| System prompt (instructions; the JSON schema travels as `output_config.format`, outside the prompt) | 4.7% | about 920 |
| Current-facts block (`<existing_facts>`, every current fact of the bank, up to 200) | 27% | about 5,300 |
| Context episodes (`contextTurns` = 12 previous session chunks, each up to 8,000 characters) | 61% | about 12,000 |
| Trigger episode and the framing | 7% | about 1,400 |
| **Input, total** | 100% | **19,699** (2,245,667 over 114 runs; 8.98 USD) |
| Output (candidates with `predicate` objects, `related`, `faithfulness`) | | **938** (106,923; 2.14 USD, 19% of the write cost) |

So on session-sized episodes the previous sessions, not the fact list, are the bulk of the prompt:
`contextTurns` was tuned for per-turn chat episodes (a few hundred characters each) and was not
configurable from the environment (it is since extract-v3, f61601f). The facts block is second and grows with the bank; the system
prompt is the only stable prefix and, at about 900 tokens, is above Opus 5.5's 512-token minimum
for prompt caching, but nothing marked it. Output is a fifth of the cost; the `predicate` object
(subject / predicate / object, filled on 19 of bank-demo's 30 facts) is stored and served but read
by nothing (recall embeds and ranks the statement).

Changes made (`extract-v3`, commit f61601f), in payoff order:
1. The context block has a character budget (`EXTRACTION_CONTEXT_CHARS`, default 16,000; the
   oldest episodes go first), and `contextTurns` is configurable (`EXTRACTION_CONTEXT_TURNS`).
2. The facts block holds candidate facts for the episode instead of the whole bank. They are cut
   by rank at 3k:
   - the top-k current facts by the engine's similarity to the episode
     (`EXTRACTION_CANDIDATE_FACTS`, default 20). A short reply is queried together with the
     preceding turn;
   - facts extracted from the context episodes, plus the 5 newest facts. The relay may not have
     indexed those yet when the worker drains episodes back to back;
   - facts whose statement entities appear in the episode or the preceding turn, at most 2k,
     matched without regard to case or accents;
   - the newest k, with a warning, when the engine fails or returns no current fact.
3. The system prompt is sent with Anthropic `cacheControl`. The ledger records cache reads and
   writes (`extraction.runs.cached_input_tokens`, `cache_write_tokens`).
4. Triage skips turns that cannot carry facts before the model call, with the reason in the
   ledger. That covers acknowledgements, fenced code only, a stack trace without prose, and JSON
   whose strings hold no language or names. A reply to an assistant question, a single word that
   is not an acknowledgement, unspaced scripts and imported documents are never skipped.
5. The output schema drops `predicate`.

### After: arm B rerun on the same 40 questions (2026-10-28)

Setup: the same 40 LoCoMo questions, seed, corpus (114 session chunks, 88.7k tokens), answering
model, frozen grader and recall limit (10) as `locomo-ab.json`. Only the extractor changed.
Fresh banks were used (`EVAL_BANK_SUFFIX=v3`, `eval-locomo4x-v3`) and promptfoo's cache did not
apply (no answer was served from it). The run used `--filter-providers B-pgvector`.
Results file: `eval/results/locomo-b-v3.json`.

| Measure (arm B, LoCoMo, 4 conversations, 40 questions) | `extract-v2` (benchmark run, 2026-10-24) | `extract-v3` (2026-10-28) |
| --- | --- | --- |
| Accuracy, overall | 75% (30/40) | 77.5% (31/40) |
| Accuracy by type: fact / decision / temporal / negative | 12/16, 5/8, 5/8, 8/8 | 12/16, 5/8, 6/8, 8/8 |
| Paired, per question | | 30 pass both, 9 fail both, 1 passes only under v3 (locomo-49-q4, temporal), 0 only under v2 |
| Write input tokens (nominal) | 2,245,667 | 1,325,729 (−41%) |
| of which prompt-cache reads / writes | 0 / 0 (not marked) | 192,100 / 1,700 |
| Write output tokens | 106,923 | 87,401 (−18%) |
| Input tokens per extraction call (mean) | 19,699 | 11,629 |
| Write LLM tokens per corpus token | 26.5 | 15.9 |
| Extraction calls / skipped by triage | 114 / 0 | 114 / 0 (LoCoMo sessions are all prose) |
| Facts written (4 banks; v2 from the erasure receipts' `memory.facts` counts, v3 from the ledger before erasure) | 701 (supersessions not recorded: the ledger was erased with the banks) | 721 (102 superseded, 3 invalidated, 2 historical, 1 rejected) |
| Ingest seconds per chunk (per bank: 44 / 47 / 48 / 49) | 10.4 (26.8 / 5.2 / 4.8 / 5.4; without the interrupted locomo44 ingest, 5.1) | 8.6 (8.6 / 8.3 / 8.7 / 9.0): slower per chunk, cause not measured (per-episode candidate recall, or API latency that day) |
| Write cost (USD, cache reads at 0.20, writes at 5 per million) | 11.12 | **6.32** (−43%) |
| Read cost / grader cost (USD) | 0.36 / 0.27 | 0.37 / 0.24 |
| Read tokens per question (prompt, mean) | 1,433 | 1,455 |
| Total per answered question incl. write (USD) | 0.294 | **0.173** |

Reading:
- Quality held on accuracy. Every question v2 answered, v3 answers too. The one gain is a temporal
  question, and one question on 40 is noise, not an improvement.
- The nine shared misses are of three kinds:
  - partial set: q8, q48, q44;
  - not extracted, answered with an abstention: q132, q45, q174, q68;
  - wrong answer: q52, q23.
- One shared miss changed character. Under v2, locomo-48-q23 abstained. Under v3 it gives a reason
  that contradicts the key. That is a false specific on a non-adversarial question, the kind of
  error arm B's abstention record is meant to avoid. Adversarial questions stay at 8/8.
- The banks grew by about the same amount: 721 facts against 701. Under v3, 102 of the new
  statements superseded an earlier fact, so the model still relates statements to facts it is
  shown. v2's supersession count was erased with its ledger, so the two cannot be compared on this.
- The cost fell by 43%. Before the run, an offline estimate put the v3 write at about 5.0 USD, a
  55% cut. It used the same corpus, 20 candidate facts per call and 2.5 characters per token. The
  likely gap is that the candidate set is larger than the 20 similarity hits, because
  context-episode facts and entity matches are added. That is inferred, not measured: no v3
  prompt was decomposed.
- The cache covers the stable prefix and nothing else. That prefix is 1,700 tokens: 113 calls read
  1,700 each and one call wrote it. The live check on the instructions alone wrote 1,017 tokens.
  The rest is the structured-output schema, which the Anthropic adapter renders ahead of the
  cached system text, unlike the "outside the prompt" estimate in the Before table. The cache
  saves about 0.73 USD here. Everything after the prefix changes with each episode, by design.
- Where the write money goes now: uncached input 4.53 USD (72%) and output 1.75 USD (28%). The
  uncached input is the context episodes, the candidate facts and the trigger together. Context is
  at most about 6,400 of the 11,629 tokens per call. The next lever is the context budget. At 8,000 characters it would remove roughly another 2,500 tokens
  per call, about 1.1 USD on this run, but it was not measured. A cheaper extraction model is the
  user's decision, not a tuning knob.

Spend for this session: 6.95 USD of the 15 USD cap. That is 6.32 for the write, 0.37 for reads,
0.24 for grading and 0.02 for the live prompt-cache check.

## Public benchmarks, 2026-10-24: LongMemEval-S and LoCoMo subsets

### Spend estimate before the run (hard cap 45 USD for this session)

Measured first on one LoCoMo conversation (`locomo49`, 25 session chunks, 18.1k corpus tokens),
Opus 5.5 list prices (4 USD per million input, 20 per million output, cache reads 0.20):

| Arm | Measured write cost on locomo49 | Per 1k corpus tokens | Basis |
| --- | --- | --- | --- |
| B-pgvector (our extraction, Opus 5.5) | 443,571 in / 24,892 out = 2.27 USD | 0.125 USD (24 LLM tokens per corpus token) | every extraction prompt carries the 12 most recent episodes and up to 200 facts |
| C-hindsight (Opus 5.5, as shipped) | 728,779 in (148,308 cached) / 88,734 out over 71 LLM calls = 4.12 USD | 0.227 USD (40 LLM tokens per corpus token; 536 s to ingest) | retain plus background consolidation |
| D-honcho (Sonnet 4.5 deriver) | not re-measured | about 0.02 USD (stage 2 ratio) | deriver counters |
| A-full-context | n/a | about 0.01 USD per question-read with prompt caching | history block cached across a user's questions |
| Reads (B, C, D) and grading | n/a | about 0.10 USD per question for three memory arms plus A, grader included | |

What the task asked for (100 LongMemEval-S questions over their own 115k-token haystacks plus 100
LoCoMo questions over all 10 conversations) is out of reach by more than an order of magnitude at
these rates: arm A alone on real LongMemEval-S haystacks is about 0.46 USD per question, and the
extracting arms would be in the hundreds of dollars (LoCoMo's 10 conversations are 183k corpus
tokens, so B about 23 and C about 42 USD on LoCoMo by themselves). Even the pooled LongMemEval
design below (evidence sessions only) at 100 + 100 questions would be about 135 USD.

The subset therefore shrank to what 45 USD buys with the arms as they are (same extraction models
as stage 2, nothing changed to make it cheaper):

| Dataset | Subset (seed 20261024) | Corpus | Arms | Estimated cost |
| --- | --- | --- | --- | --- |
| LoCoMo | 4 of 10 conversations (seeded sample: conv-44, 47, 48, 49), 2 questions per category per conversation = 40 questions, 8 per category, 10 per conversation | 114 session chunks, 88.7k tokens | A, B, C, D, plus B-raw (pgvector over raw chunks, no extraction: the plan's own definition of arm B, zero write cost) | B 11.1, C 20.1, D 1.8, A 1.0, reads 3.8, grading 1.2 = 39.0 (6.4 of it already spent on the measurement) |
| LongMemEval-S | 4 of each of our five types = 20 questions (one per type per synthetic user), 4 users | 100 chunks from 36 evidence sessions, 129.5k tokens | A and B-raw only; B with extraction (about 16 USD) and C (about 29 USD) do not fit; D (about 3.5 with its reads and grading) only if the LoCoMo run comes in under its estimate | A 1.0, reads 0.5, grading 0.25 = 1.8 (plus 3.5 with D) |

Estimated total 40.8 USD without D on LongMemEval, 44.3 with it; the LoCoMo run goes first (arms A and
B, then C with its trace totals watched per bank, then D and B-raw), and the LongMemEval arms are
decided on the actual spend after it. Hindsight's number is the least certain: its consolidation
cost did not scale linearly in stage 2.

### LoCoMo: 4 conversations, 40 questions, five arms

Setup: `locomo10.json` conversations conv-44, 47, 48, 49 (seeded sample of the 10), one corpus
chunk per session (114 chunks, 88.7k tokens), 2 questions per dataset category per conversation
(40: 8 multi-hop, 8 temporal, 8 open-domain, 8 single-hop, 8 adversarial). Answering model
`anthropic:claude-opus-5-5` everywhere, grader `anthropic:claude-opus-5-5` with the frozen prompt
(so a hedged answer fails and an adversarial question passes only on an explicit "not in the
conversation"). Recall limit 10 as in stage 2 (`limit` is shared by facts and episodes, which is
why arm B's material is small: its ten best hits are mostly facts). Arm B-raw is pgvector over the
raw session chunks with no extraction (the plan's own definition of arm B). Arm A's history block is
prompt-cached. Extraction: B and C Opus 5.5, D Sonnet 4.5 (Honcho cannot drive Claude 5).
Results files: `eval/results/locomo-ab.json`, `locomo-c.json`, `locomo-d-braw.json`
(`npm run eval:summary -- <the three files>`; `npm run eval:ci -- <the three files>`).

| Measure | A-full-context | B-pgvector | B-pgvector-raw | C-hindsight | D-honcho |
| --- | --- | --- | --- | --- | --- |
| Accuracy, overall (40) | 75% (30/40) | 75% (30/40) | 68% (27/40) | 83% (33/40) | 63% (25/40) |
| Accuracy, decision = 1 multi-hop (8) | 75% | 63% | 63% | 75% | 50% |
| Accuracy, fact (16) = 4 single-hop (8) / 3 open-domain (8) | 81% = 88% / 75% | 75% = 75% / 75% | 69% = 63% / 75% | 88% = 88% / 88% | 69% = 63% / 75% |
| Accuracy, temporal = 2 temporal (8) | 75% | 63% | 75% | 88% | 63% |
| Accuracy, negative = 5 adversarial (8) | 63% | 100% | 63% | 75% | 63% |
| Cluster-robust 95% CI, overall (G = 4, t = 3.18) | [65.8, 84.2] | [47.4, 100] | [43.6, 91.4] | [74.5, 90.5] | [32.4, 92.6] |
| Read tokens per question (prompt, mean, nominal) | 31,982 (of which 27,000 cache reads) | 1,433 | 10,745 | 9,191 | 11,551 |
| Write tokens, total (4 banks) | 0 | 2,352,590 | 0 | 4,072,499 (350 LLM calls, 711,006 cached; 164,781 embedding) | 240,374 (deriver counters) |
| Write LLM tokens per corpus token | 0 | 26.5 | 0 | 45.9 | 2.7 |
| Retrieval latency p50 / p95 (ms) | n/a | 244 / 294 | 266 / 338 | 3,882 / 5,148 | 241 / 385 |
| End-to-end latency p50 / p95 (ms, uncached) | n/a (the recorded file is the rerun after the server kill; every A answer came from cache) | 2,514 / 4,229 | 3,088 / 4,850 | 6,837 / 9,197 | 3,268 / 5,390 |
| Ingest seconds per chunk | n/a | 10.4 | 0.5 | 22.6 | 7.5 |
| Write cost, total (USD, as billed: cache reads at 0.20, Sonnet 4.5 prices for D) | 0 | 11.12 | 0 | 20.27 (22.97 at list) | 1.25 |
| Read cost, total (USD, as billed) | 1.37 (5.27 nominal; prompt caching) | 0.36 | 1.86 | 1.62 | 2.02 |
| Grader cost, total (USD) | 0.25 | 0.27 | 0.23 | 0.27 | 0.24 |
| Total per answered question incl. write (USD) | 0.041 | 0.294 | 0.052 | 0.554 | 0.088 |

Paired differences (cluster-robust, G = 4; MDD at 80% power in brackets; none significant):
A−B 0.0 [24.0]; A−B-raw +7.5 [19.9]; A−C −7.5 [10.4], t interval [−15.5, 0.5], cluster bootstrap
[−10, −2.5]; A−D +12.5 [31.2]; B−B-raw +7.5 [10.4]; B−C −7.5 [31.2]; B−D +12.5 [26.2]; C−D +20.0
[29.4]. Per type nothing comes within half of its MDD (eight questions per type per arm; the per-type
MDDs are 26 to 100 points), so there is no per-type difference to report under the plan's rule.

Reading:
- Hindsight is the best arm on this sample (33/40, ahead of full context by three questions, with
  the narrowest interval), and the only engine that beats pgvector-plus-extraction here, by 7.5
  points on 40 questions with an MDD of 31. Its wins over B are on temporal (7/8 vs 5/8) and fact
  (14/16 vs 12/16); B is better on adversarial (8/8 vs 6/8).
- Full context is not a ceiling on LoCoMo under this grader: 75%. Its ten misses are three
  adversarial questions answered with invented specifics (the strict negative rule), three "partial
  set" answers (keys that list three or four items), and four genuine misreads of a 20k-token
  two-person transcript. Honcho's own page reports 75.6% for a Haiku 4.5 full-context baseline on
  LoCoMo; the number is in the same place for a different reason (its grader is more lenient, its
  model smaller).
- Arm B matches full context on 1,433 prompt tokens per question, 22x fewer, and is the only arm
  with no false specifics on adversarial questions: with facts crowding out episodes under the shared
  limit, the answering model sees extracted statements only, and when none fits it abstains. The
  price is the misses where the fact was never extracted (q132, q45, q68: "I do not have that
  information" against a key that is in the transcript), and the 11 USD of extraction for 89k
  corpus tokens, 26 LLM tokens per corpus token (each prompt carries the 12 previous sessions and
  up to 200 facts; `contextTurns` was not configurable from the environment then; it is since extract-v3, f61601f).
- B-raw (no extraction) is 7.5 points under B on the same questions, interval [−0.5, 15.5], bootstrap
  [2.5, 10]: the closest thing to a finding in this run, and it says extraction earns its keep on
  abstention (8/8 vs 5/8) rather than on recall.
- Honcho is last (25/40) with Sonnet 4.5 doing its extraction and the most material per question
  (11.5k tokens); its misses are the same partial-set and adversarial questions as B-raw plus three
  more facts, and its representation path produced no answer the message search did not.
- Costs per answered question including the write side: A 0.041, B-raw 0.052, D 0.088, B 0.294,
  C 0.554 USD. On a 20k-token history read 10 times, extraction does not amortize; Hindsight's 46
  LLM tokens per corpus token (11% of them output tokens at five times the input price) is the
  same order as stage 2's 68; output tokens are 11% of its write tokens and about 38% of its write cost.

### LongMemEval-S (pooled evidence sessions): 4 synthetic users, 20 questions, arms A and B-raw

Setup: 4 questions of each of our five types (seeded; dataset types in the table), one per type
per user; a user's history is the union of its questions' evidence sessions in dataset order
(7 to 14 sessions, 17 to 40 chunks, 21k to 52k tokens; 129.5k tokens in all). Temporal questions
carry the dataset's `question_date` as `asOf`. Only full context and pgvector over raw chunks ran:
extraction with Opus 5.5 (about 16 USD) and Hindsight (about 29 USD) did not fit the cap after the
LoCoMo run, and Honcho (about 3.5 USD) would have taken the total past it. Results file:
`eval/results/longmemeval-a-braw.json`.

| Measure | A-full-context | B-pgvector-raw |
| --- | --- | --- |
| Accuracy, overall (20) | 95% (19/20) | 90% (18/20) |
| preference = single-session-preference (4) | 100% | 100% |
| fact = single-session-user 1 / single-session-assistant 2 / multi-session 1 | 100% | 75% (the multi-session question) |
| decision = knowledge-update (4) | 100% | 100% |
| temporal = temporal-reasoning (4) | 75% | 75% |
| negative = abstention (4: one each of knowledge-update, multi-session, single-session-user, temporal-reasoning) | 100% | 100% |
| Cluster-robust 95% CI, overall (G = 4) | [79.1, 100] | [71.6, 100] |
| Read tokens per question (prompt, mean, nominal) | 46,377 (37,070 of them cache reads) | 18,265 |
| Retrieval latency p50 / p95 (ms) | n/a | 288 / 359 |
| End-to-end latency p50 / p95 (ms) | 3,917 / 6,843 | 3,182 / 5,712 |
| Read cost, total (USD, as billed) | 1.17 (3.80 nominal) | 1.55 |
| Grader cost, total (USD) | 0.11 | 0.11 |

A−B-raw +5.0 points, interval [−10.9, 20.9], MDD 20.8, not significant. The three misses: both
arms on the same temporal-reasoning question (neither committed to which show was started first;
the key says the answer is in the sessions), and B-raw on the one multi-session question (a count
of five items across sessions, it found four). Knowledge updates (4/4 both arms) and abstentions
(4/4 both) were not where either arm failed on this sample. With the haystack reduced to the
evidence sessions plus other questions' evidence, this is an easier task than LongMemEval-S, and
20 questions over 4 users cannot rank anything: it says the pipeline runs on this benchmark and
what it costs, no more.

### Actual spend against the estimate

As billed (Anthropic prices: Opus 5.5 at 4 / 20 USD per million, cache reads 0.20, cache writes
5; Sonnet 4.5 at 3 / 15 for Honcho's deriver; OpenAI embeddings under 0.02):

| Item | Estimate | Actual |
| --- | --- | --- |
| Measurement on locomo49 (B and C ingestion, 2 answers) | 6.4 | 6.4 |
| LoCoMo arm B extraction (other 3 banks) and reads | 9.6 | 8.6 write + 0.4 read |
| LoCoMo arm C Hindsight (other 3 banks) and reads | 16.0 + 1.0 | 16.2 write + 1.6 read |
| LoCoMo arm D Honcho | 1.8 + 1.0 | 1.25 write + 2.0 read |
| LoCoMo arm A | 1.0 | 1.4 |
| LoCoMo B-raw reads | 0.8 | 1.9 |
| LoCoMo grading (200 rows) | 1.2 | 1.3 |
| LongMemEval A and B-raw with grading | 1.8 | 2.9 |
| **Total** | **39.0 + 1.8 = 40.8** | **about 44.0** (about 53 at nominal list prices, i.e. without prompt caching and with Hindsight's cache reads at full price) |

Under the 45 USD cap by about one dollar; the reads of B-raw and D (ten session chunks each) and
the grader were under-estimated, Hindsight came in on its measured rate. Nothing was retried
after a failure except the arm-B rows lost to the server kill, which re-spent nothing (A answers
and grades came from promptfoo's cache, B's banks from the ingestion record).

### Deviations from the task and follow-ups

- Subset: 40 LoCoMo questions over 4 of 10 conversations and 20 LongMemEval questions over
  pooled evidence sessions, instead of 100 + 100 over the full benchmarks; arms B (with extraction),
  C and D did not run on LongMemEval. All cost, see the estimate above. The sample is seeded
  (`EVAL_DATASET_SEED=20261024`) and rebuilt by `eval/datasets/build.ts`; growing it is a matter of
  budget, not code.
- Corpus unit is a session chunk, not a turn, in every arm (see `eval/README.md`); LoCoMo's two
  speakers are both the Subject (role `user`, names in the text), so Honcho's "user" peer
  represents both and arm B's extractor sees a two-person dialogue.
- The grader is ours, not the benchmarks': stricter on hedging and on abstention than LongMemEval's
  per-type prompts or LoCoMo's F1, so the absolute numbers are not comparable to published scores
  (the comparison in `spike-results.md` says what can be said).
- Arm B's material is small under the shared recall limit (ten best hits, mostly facts); a per-kind
  limit in `recall` would make B's read side comparable to the engines' (follow-up for `src/`).
- Extraction cost per corpus token (26 LLM tokens in B, 46 in Hindsight) is the number that
  decides what any of these engines costs at history sizes like LoCoMo's; `RetainPipeline`'s
  `contextTurns` (12 previous episodes in every prompt) was not configurable from the environment (done in extract-v3, f61601f)
  and is most of arm B's write cost on session-sized episodes (follow-up for `src/`).
- Cleanup: the twelve `eval-*` pgvector banks (four B, four B-raw, four LongMemEval raw) were erased
  with receipts (`erasure_requests` holds the ids, all `receipted`), the four Hindsight banks deleted
  (404 on re-read), the four Honcho workspaces and their sessions deleted (workspace list empty);
  `bank-demo` untouched. The ingestion records under `eval/results/` still name the erased banks, so
  a rerun must delete those entries first (`eval/README.md`), or go to fresh banks with `EVAL_BANK_SUFFIX` (since 2026-10-28).

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
