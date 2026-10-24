# Public benchmark sources

Raw files live in `eval/datasets/raw/` (gitignored) and are untrusted data: the loaders parse them
with zod (`longmemeval.ts`, `locomo.ts`) and copy text into our corpus format; nothing in them is
executed, imported or rendered as a template. Re-fetch with the commands below; the hashes are what
the recorded run used.

## LongMemEval (Wu et al. 2025, "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory", ICLR 2025)

- Licence: MIT (repository licence file at the commit below; the Hugging Face dataset card says `license: mit`).
- Code and paper: https://github.com/xiaowu0162/LongMemEval, commit `9e0b455f4ef0e2ab8f2e582289761153549043fc` (main, 2026-05-11).
- Data: the authors deprecated the original `xiaowu0162/longmemeval` dataset (its card, revision
  `2ec2a557f339b6c0369619b1ed5793734cc87533`, says it is replaced by the cleaned release, which removes
  noisy history sessions that interfered with answer correctness). The file used is
  `longmemeval_s_cleaned.json` from https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned,
  revision `98d7416c24c778c2fee6e6f3006e7a073259d48f` (2025-09-19), 277,383,467 bytes,
  sha256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.
- Fetch:

  ```bash
  mkdir -p eval/datasets/raw && curl -L -o eval/datasets/raw/longmemeval_s_cleaned.json "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json"
  ```

- Contents: 500 questions (`question_type` single-session-user 70, single-session-assistant 56,
  single-session-preference 30, multi-session 133, knowledge-update 78, temporal-reasoning 133; 30 of
  them abstention questions with ids ending in `_abs`), each with its own haystack of about 48
  timestamped sessions and the ids of its evidence sessions. Timestamps `2023/05/20 (Sat) 02:21` are
  read as UTC.
- Subset and deviations: `longmemeval.ts` header and `eval/RESULTS.md`. The sampled questions are
  pooled into synthetic users whose history is the union of their questions' evidence sessions
  (not the benchmark's 115k-token per-question haystack), so the numbers are not LongMemEval-S scores.

## LoCoMo (Maharana et al. 2024, "Evaluating Very Long-Term Conversational Memory of LLM Agents", ACL 2024)

- Licence: Creative Commons Attribution-NonCommercial 4.0 International (`LICENSE.txt` at the commit
  below). Used here for internal, non-commercial evaluation; the committed question subset quotes
  the dataset's questions and answer keys with attribution to Snap Research. Do not ship it in a product.
- Repository: https://github.com/snap-research/locomo, commit `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376` (main, 2024-08-13).
- File: `data/locomo10.json`, 2,805,274 bytes, git blob `d95b872480b413d935821fdc3c84f8a8f5f29e73`,
  sha256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`.
- Fetch:

  ```bash
  mkdir -p eval/datasets/raw && curl -L -o eval/datasets/raw/locomo10.json https://raw.githubusercontent.com/snap-research/locomo/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json
  ```

- Contents: 10 conversations (19 to 32 dated sessions, 369 to 689 turns, about 11k to 23k tokens
  each; images are not released, their captions are), 1,986 questions in categories 1 multi-hop
  (282), 2 temporal (321), 3 open-domain (96), 4 single-hop (841), 5 adversarial (446; `adversarial_answer`
  instead of `answer`). The category numbering is the file's; the names follow the paper and the
  repository's evaluation code. Timestamps `1:56 pm on 8 May, 2023` are read as UTC.
- Subset and category mapping: `locomo.ts` header and `eval/RESULTS.md`.
