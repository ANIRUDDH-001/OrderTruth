# Final assembly candidate — 12 November 2026

Prepared locally, not rendered, published or submitted. Preserve the existing incomplete review cut and original media. No further live-case access is needed for assembly.

## Verified execution evidence

Execution run: https://github.com/ANIRUDDH-001/OrderTruth/actions/runs/43122086790 (attempt 1, success).
Artifact: `ordertruth-execute-43122086790`, ID `13900254242`.
Published execution commit: `5f6dac424f3b35d6b42258bd754a5724070964c2`.

- Receipt: `rx_b490220f-9a6f-461a-b81e-2f41edefc78f`.
- Plan: `rp_b311e874-e7ca-4ec5-b268-5ae3c1d719e4`.
- Plan SHA256: `b9ed5ae8b9016ad0081b98d88af6e63145fdf61943fb1ff83235e992342ede75`.
- Keeper: `mo_bf9bb97b-495c-473f-9905-1627b85dec99`, placed.
- Sole duplicate: `mo_fbf7e14b-8ebf-4b49-8385-0857ff21f04e`, locally voided.
- Hosted capture validated successful receipt, one active matching keeper, unchanged provider evidence, and the same persisted receipt after reload. This is recorded verification, not a new live reconciliation.
- MP4: 32.333333 seconds, H264, 1920×1080, 30fps, hosted full decode PASS.
- Download SHA256 verified: `38c9034c21c517ce23e7314e5b77a73927ee53e812f3a81053985a24abbc41f4`.

## Edit and evidence

`scene-sources.final.json` preserves all eleven scene boundaries and the 162-second duration. `final-assembly-assets.json` identifies the exact copied assets, hashes and originating runs. Capture sidecars and original audio are copied byte-for-byte; no original footage, graphics or Phase A materials are changed.

| Scenes | Source |
|---|---|
| S01, S04, S05; part of S02 | Existing deterministic recording of the same case |
| S02, S03, S11 | Existing approved source/title/end graphics |
| S06–S08 | Fresh Groq `openai/gpt-oss-120b` step, run 43118550257, persisted after reload |
| S09 | Proposal run 43120206394, separate approval run 43121334527, execution run 43122086790 |
| S10 | Execution receipt, navigation/reload and same persisted receipt |

The AI selected `HANDLER_TIMING`; `concluded=false`. The final overlay explicitly says “One recorded AI step | Investigation not concluded”. A complete merchant recovery does not imply a completed AI investigation. Request count is based on one admitted POST, a fresh validated result and the backend no-retry contract, not independent provider metering.

Existing approved libflite `slt` narration is reused from `narration/offline-approved`. One S07 sentence is omitted: “Autopilot uses the updated evidence to choose its next step.” Only one model step was authorized and recorded. Its original interval, 84.44–88.37 seconds, is muted during hosted assembly and omitted from captions; the rest retains its timing. Original WAVs and narration QC remain unchanged. S08 describes the conditional ability to conclude and is displayed with the explicit not-concluded overlay. Review the omission and overlay before publication.

Coverage validation: 136.033 seconds of product picture, 24 seconds of approved graphics and 1.967 seconds of held frames. Unique selected product source material: 127.825 seconds. Output target: 162 seconds / 4860 frames, 1080p30, H264/AAC 48kHz. Final decode, frame count, audio levels and visual/audio quality remain NOT_TESTED until hosted rendering and review.

## Adapter changes

- Allow AI scene subclips fully inside the verified continuous AI interval. Receipt and execution events still require the whole event interval in the selected cut. Evidence sidecars remain hash-bound.
- Permit only nonnegative integer/null provider usage counts at the exact AI-response usage path; token credentials remain forbidden.
- Validate every supplied proof, even for proposal/approval clips without events.
- Allow explicit omission of an exact existing narration chunk, remove its caption and mute its audio without regenerating speech.
- Retain sequential encoding, original graphics, caption timing and all final media checks. Rendering remains blocked outside GitHub Actions.

## Local checks

From `video/render-test`:

```text
python production/test_assembly_manifest.py
python production/assemble-host.py final/prepared --manifest production/scene-sources.final.json --validate-only
python production/assemble-host.py final/review-validation --manifest production/scene-sources.review.json --validate-only
node scripts/verify-publication.cjs
node scripts/test-cloud-stage-guard.cjs
python scripts/test-workflow.py
git diff --check
```

Python syntax and all eleven narration WAV headers/durations were also checked without rendering. Reviewable local outputs are `qc/final-assembly-preparation.json` and `qc/OrderTruth-Final-Prepared.srt`; they are not publication assets.

## Later hosted procedure — not authorized or performed

1. Owner reviews the final manifest, narration omission, adapter diff and expanded publication inventory. Recheck local/remote video HEAD is exactly `5f6dac424f3b35d6b42258bd754a5724070964c2`; stop on drift.
2. Obtain explicit authorization for one publication and one `assemble-final` run. The prepared local configuration uses `ASSEMBLE_FINAL`, empty plan fields, that exact predecessor and `production/scene-sources.final.json`. No guest secret is injected into assembly.
3. Stage only the reviewed production code/configuration, final manifest/assets and inventory changes. Leave the reconciliation helper and ignored QC/review outputs unstaged. Commit with a reviewed message containing `[skip render]`, then normal-push once to `HEAD:refs/heads/video/cloud-render`.
4. The existing branch-push workflow creates attempt 1 behind `ordertruth-video` environment protection. Report its exact commit/run for owner approval. Do not dispatch separately or rerun.
5. The existing assembler renders sequentially in Actions and uploads only final MP4/SRT/QC. Capture, plan, approve, execute, AI and smoke steps are skipped. Download and verify hashes/QC, then review the full film for framing, timing, narration and truthful claims before treating it as submission-ready.

No application source, deployment settings, secrets or environment protections changed. No commit, push, workflow, model call or case mutation was performed during this preparation.
