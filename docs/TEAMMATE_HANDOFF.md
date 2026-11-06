# OrderTruth teammate handoff — 26 October 2026

## What the project does

OrderTruth investigates mismatches between PayPal Sandbox payment evidence and a reference merchant's records. Deterministic rules detect incidents. An optional AI investigator explains possible causes and next checks. A human approves an exact merchant-only repair; the application records a receipt and checks the result. AI never authorizes PayPal capture or refund.

Evidence sources must stay distinct: provider readback, merchant records, controlled test faults and AI hypotheses. A provider capture does not prove that the merchant handled it correctly; a plausible explanation does not establish a cause.

## Where we stand

- RECORDED_NOT_REPRODUCED in this handoff: the existing application has local and hosted workflow evidence. Current hosted release qualification remains incomplete.
- VERIFIED from the completed results document: the first AI study is complete. All four separate reviewer/control comparisons returned REGRESSION. Its bounded conclusion is no demonstrated incremental AI benefit in that run.
- That study used 16 disclosed fixtures, including eight primary cases. It is exploratory: reviewer selection was post hoc, original Stage 1 instructions omitted some rubric definitions, and the reviewers disagreed. Stage 2 followed an amended procedure; the old study must not be rewritten or rerun to replace its result.
- The analysis, adapter, evidence and related documentation are still uncommitted. A GitHub clone alone will not contain this local progress. The project owner must provide this handoff and the relevant current documents separately; do not assume the remote is current.
- Non-AI release work is proceeding separately: supported-runtime setup, judge access, failure handling, accessibility, desktop/mobile rehearsal and bounded hosted webhook/crash qualification. Hosting is intended to remain free through 15 December 2026; future availability is not yet guaranteed.

## Your first task: become the fresh-case custodian

You can help protect a fair future AI evaluation. The implementation session will inspect the old, disclosed cases and fix concrete weaknesses. You hold the new cases privately so those fixes cannot be tuned against them.

**For now, read this brief and confirm that you can keep the cases private. Do not write or run held-out cases yet.** We first need a shared evaluation specification: supported input format, intended scope, case count and categories, evidence rules, scoring definitions, thresholds, runtime/quota budget and failure/retry handling. None of those numbers is finalized by this handoff.

Tell the owner how much time you can spare and whether you can also do an independent usability rehearsal. Send only your availability and questions at this stage. You do not need credentials or paid services.

## After the evaluation specification is agreed

1. Work in a private folder or separate private workspace that the implementation agent cannot access. Do not put held-out cases in the shared repository, its ignored folders, this conversation or an agent session with access to the implementation conversation.
2. Use synthetic, internally consistent evidence in the agreed schema. Never use real customer information, secrets, payment credentials or production calls. Build cases from the agreed domain requirements rather than copying or lightly renaming the old 16 fixtures.
3. Follow the pre-agreed distribution. It should cover healthy behavior, supported incident classes, legitimate pending behavior, and insufficient or conflicting evidence. A deliberately unsupported scenario must be labelled out of scope rather than silently treated as a core failure. Do not add harder cases after seeing outputs.
4. For each case, privately record: case ID; scope/category; exact evidence visible to the investigator; supported diagnosis or acceptable alternatives; facts that remain unknown; acceptable next checks and why; unsupported claims to avoid; and the evidence IDs justifying each expected answer. Do not include hidden facts as requirements an investigator should magically infer.
5. Validate each case and answer key independently before model output exists. Check references, timestamps, amounts, ordering and whether the proposed conclusion follows from the supplied evidence. Resolve ambiguous ground truth before sealing. If nobody can independently validate it, record that limitation.
6. Keep the answer key separate from model inputs. Freeze both, record UTC time and SHA-256 hashes, and keep an unchanged copy. You may share counts, specification compliance and hashes with the owner; do not share case contents or answers with the tuning session.
7. Wait for the owner to confirm the implementation, deterministic controls, rubric, thresholds and failure/retry policy are frozen. Only then transfer the sealed input pack to a designated evaluation runner with no role in tuning. Send the answer key only to the designated scorers. If the input format needs private validation, use an isolated validator and share only the error category.
8. Generate every arm's outputs under the agreed procedure. Preserve failures, timeouts and retries. Do not regenerate an answer because it looks poor. Randomize arm labels and presentation order before scoring; retain the mapping separately until scores are sealed.

If a held-out case or answer leaks to the tuning session, stop using that case as untouched evaluation evidence. Record the exposure and apply the replacement/exclusion rule agreed before the run. Never hide a leak or selectively discard a difficult result.

## Human scoring, if you can help

The study will measure diagnosis, evidence support, appropriate next checks, honest uncertainty, unsupported claims/unsafe advice, and operational latency/quota separately. The exact rubric and decision rules still need to be agreed; this brief does not authorize an evaluation run.

- Read the complete rubric before scoring and calibrate only on disclosed development examples.
- Score anonymized outputs against the supplied evidence and protected answer key. Do not infer quality from fluent wording, length or a guessed provider identity.
- Attach a statement or evidence reference to each substantive flag. Record ambiguity explicitly.
- Prefer two independent scorers who seal their sheets before discussing disagreements. Preserve both original sheets. Use only the pre-agreed adjudication procedure; do not select the more favorable reviewer.
- If you are the sole author and scorer, disclose that dependence. If scoring is AI-only, label it AI-reviewed. One teammate does not establish two independent human reviews.

## Separate task: usability rehearsal

After the release candidate is ready, use a fresh browser session and only the written judge instructions. Record whether you can enter, understand the evidence, investigate, obtain the exact approval, perform the permitted merchant repair and understand/reopen its receipt. Test a phone as well if available; identify real-device testing versus emulation.

Record step, expected behavior, observed behavior, blocker and sanitized screenshot where useful. Ask for help when stuck, but record the intervention: that segment is assisted. Do not share owner credentials, perform genuine payment actions, interrupt hosting or delete database records. Use only the controlled judge scenario approved for the rehearsal.

Doing the rehearsal before authoring cases can expose product behavior and influence case design. Record that exposure, or perform the rehearsal after cases are sealed. A teammate already familiar with the application is not a first-time-user study participant.

## What to send back

Initially: availability, ability to hold the pack privately, and questions about the specification. Later: case counts, validation status, freeze time and hashes only. After authorized execution: sealed scoring sheets and a separate usability report. Keep held-out contents and answers out of the implementation conversation until final evaluation outputs and scores are locked.

The owner will relay materials; this handoff does not send messages or grant access to anyone. No commit, push, deployment, payment, paid service or new model run is authorized by this document.
