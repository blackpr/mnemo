# Eval

Runs `spike-plan-hindsight-vs-honcho.md`. **We do not build an eval framework.** An existing one
runs the cases, calls the grader, caches, and records tokens and latency. This folder holds only
what no framework can supply for us.

```
eval/
  questions/      question set over our own transcripts (schema + answer-key audit log)
  grader/         the frozen grader prompt (committed) and its sanity cases: wrong, hedged, near-date answers
  arms/           one thin adapter per arm: full-context, pgvector, hindsight, honcho
                  (each calls the REST attachment or the RetrievalEngine port, nothing else)
  stats/          one script: cluster-robust 95% CI by conversation, minimum detectable difference
  <framework config>  e.g. promptfooconfig.yaml
  corpus/         (gitignored) raw + normalized transcripts
  results/        (gitignored) framework output
```

Framework: `promptfoo` (TypeScript stack, custom JS providers, model-graded assertions, per-case
latency and token capture) or `Inspect AI` (Python). Decide on spike day 1 after checking current
features. If the chosen framework already computes a usable CI, drop `stats/`.

Rules:
- Same answering model and same grader model for every arm; model refs recorded in every result.
- Corpus is frozen after day 2; dropped or corrected questions are logged, never silently removed.
- Nothing here is imported by `src/`.
