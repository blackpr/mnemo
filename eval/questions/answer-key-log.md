# Answer-key audit log

Every question in `questions.jsonl` starts as a model draft with `audited: false`. A human reads
the evidence turns, then either marks it `audited: true` (optionally correcting the key) or drops it.
Nothing is silently removed or rewritten: each change is logged here with the reason, so the
question set stays reproducible and the drop rate is known (LoCoMo-style flawed keys are what
this log exists to catch).

Format: one line per change, newest last.

| Date | Question id | Action | Reason |
|---|---|---|---|
| 2026-10-23 | (all) | drafted | 40 candidates drafted by `npm run eval:draft-questions` from 4 conversations (10 each); none audited. Known caveats for the auditor: conversations 3a6c5eae and b4dc1b1e are a resumed session and overlap, so several questions are near-duplicates; some `fact` keys rest on assistant statements rather than the user's words; drafted `asOf` values are UTC instants while a question may name a local-time clock reading. |
| 2026-10-23 | 3a6c5eae-01 | flagged | Both arms failed it in the smoke run; the grader found the answers contradict the key on whether the "If asked" answers belong in SAY.md. The conversation changes its mind on this (see its later turns and the overlapping session b4dc1b1e), so the key may describe only the final state. Auditor to confirm or correct the key; not dropped. |
