# Historical investigator review inputs

This directory preserves the selected reviewers' original Stage 1 sheets and their Stage 2 returns for the AI-reviewed, post-hoc exploratory analysis governed by A2/A3 in `docs/INVESTIGATOR_EVAL_PREREGISTRATION.md`.

- `stage2-input-manifest.json` records SHA-256 values of the preserved files.
- `codex-stage2-original.csv` is the exact Codex final response; it includes one malformed CSV note.
- `codex-stage2-normalized.csv` is the derived parseable input. `codex-csv-normalization.json` identifies the format-only correction; no identity/scoring field changed.
- `codex-review-audit.json` records the fresh-session controls, zero tool events and remaining account/blinding limitations.
- Original local sources were not edited or replaced. Public Stage 1 copies retain their original bytes; excluded Sheet A and repeatability Sheet C remain in the historical audit and are not analysis inputs.

At this pre-unblinding checkpoint no decision result is claimed. The evidence log records the committed sequence and later completion. The historical missing rubric definitions, post-hoc selection and other A2/A3 limitations remain in force; these materials do not establish the preregistered human-review study.
