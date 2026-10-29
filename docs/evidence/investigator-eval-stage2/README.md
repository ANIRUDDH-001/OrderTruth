# Historical investigator review inputs

This directory preserves the selected reviewers' original Stage 1 sheets and their Stage 2 returns for the AI-reviewed, post-hoc exploratory analysis governed by A2/A3 in `docs/INVESTIGATOR_EVAL_PREREGISTRATION.md`.

- `stage2-input-manifest.json` records SHA-256 values of the preserved files.
- `codex-stage2-original.csv` is the exact Codex final response; it includes one malformed CSV note.
- `codex-stage2-normalized.csv` is the derived parseable input. `codex-csv-normalization.json` identifies the format-only correction; no identity/scoring field changed.
- `codex-review-audit.json` records the fresh-session controls, zero tool events and remaining account/blinding limitations.
- Original local sources were not edited or replaced. Public Stage 1 copies retain their original bytes; excluded Sheet A and repeatability Sheet C remain in the historical audit and are not analysis inputs.

At this pre-unblinding checkpoint no decision result is claimed. The evidence log records the committed sequence and later completion. The historical missing rubric definitions, post-hoc selection and other A2/A3 limitations remain in force; these materials do not establish the preregistered human-review study.

Completion on 2026-10-25: A4 replaced the commit gates with the published 45-file hash snapshot; the changes remain uncommitted. The original paragraph above describes the preserved input checkpoint. `unblinding-audit.json`, the two `*-analysis.json` files, four `*-versus-*.json` files and descriptive records contain the completed, separate reviewer results. Every comparison returns REGRESSION under the frozen rules; see `docs/INVESTIGATOR_EVAL_RESULTS.md` for limitations, reproduction and interpretation. `live-automated-report.json` and `live-arm-key.json` are byte-identical copies of the originals. `verification/independent-arithmetic.py` checks primary arithmetic without importing the TypeScript adapter. Historical consensus is not included or used.
