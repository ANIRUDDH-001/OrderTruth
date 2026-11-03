# OrderTruth V3 — W4 documentation and demo plan

Date: 2026-11-03 IST. Revision 2 (Claude fixes 1–4; owner selected V2-first). Product baseline: W1 `8300b3ff305d9a71a4dd562b97b0eef6b01708e2`; HEAD at planning intake `d55a1a576842cab06f4550edd7b007791db2bcfc`.

STATUS: **REVISION 1 PASS WITH FIXES; REVISION 2 READY FOR RE-REVIEW.** Fixes 1–4 incorporated; owner explicitly selected V2-first in the follow-up answer. Owner superseded W4 HOLD with planning-only authorization. No README rewrite, demo recording, product code, publication, submission, deployment or Git writes are authorized yet. One builder; owner relays reviews. A checkpoint is complete only after Claude PASS and owner commit. W2 Revision4 PASS was relayed; its owner commit and capacity recheck remain pending.

## 1. Bounded outcome

Prepare truthful README guidance, a short demo script and submission draft from delivered functionality. Preserve the V2 investigation/recovery path and W1 static Integration Lab. Make synthetic merchant faults, genuine recorded Sandbox observation, human-written reference fix and unproven AI migration value unmistakable. No new feature or AI experiment is needed to tell this story.

W4 may progress while W2 is blocked, but it must not represent W2 as complete, run untrusted candidates, or anticipate W3 results. Use the already accepted fixed-lab result as the demonstration foundation. W2/W3 statements remain dated status statements until their own reviews and owner commits establish stronger evidence.

## 2. Inputs and claim status

Read these selectively during implementation; never read credential files or the holdout directory:

- `AGENTS.md`, master plan relevant judging/evidence sections, full v3 handoff and post-Gate-A roadmap.
- `.work/v3/w1/checkpoint-1/claude-review/REVIEW.md`: Claude PASS with public-source, clean-build and runtime notes. Reviewer typechecks/full1152 tests are RECORDED_NOT_REPRODUCED in this planning checkpoint.
- `docs/evidence/lab/README.md` and its eight accepted JSON artifacts; assurance validation code and historical pins. Inspect, do not change them.
- `.work/v3/gate-a/GATE_A_RESULT.md`, `REPRODUCIBILITY.md`, W1 checkpoint report/validation and current W2 report for claim provenance, not a new execution attestation.
- Existing root `README.md`, `docs/HOSTED_APPLICATION.md`, `docs/POSTGRES_LOCAL.md`, `docs/RELEASE_CHECKLIST.md`, existing package scripts and frontend packaging code. Older hosted claims are historical inputs, not current availability proof.

| Claim | Permitted wording / proof requirement |
|---|---|
| Gate A | Locally reproduced fixed synthetic P1/T1 V-A experiment; original forced race gives two orders; human-written reference fix passes applicable rungs; nine controls rejected for intended defects; source `fc85ac3db1388bd84a3a55b8198d9dc3b2ad6c86` |
| W1 | Reviewed static publication of those records; hashes establish consistency, not independent execution authenticity; source S differs from publication/build identity P |
| Runtime | Historical Gate A host controller Node24.11.0, candidate Node22.18.0; W1 supported-runtime validation Node22.18.0/pnpm11.4.0; each new check records actual runtime |
| Genuine PayPal | Separately recorded Sandbox capture/readback used by the V2 judge flow; lab fixture is synthetic and neither protected nor repaired that payment |
| AI | Existing V2 investigation is separate from V3 migration; no applied AI migration patch or demonstrated migration advantage in Gate A; W3 evaluation NOT_TESTED/unauthorized |
| Hostile candidates | W2 hardening not yet qualified; never describe Gate A/W1 as safe for arbitrary hostile candidates |
| Public reproduction | Last recorded exact-source check unsuccessful; label locally reproduced/public source not verified until a new unauthenticated exact-commit check succeeds |
| Hosted availability | Existing URL/config is historical; do not promise current uptime, backend access or fresh AI without separately authorized verification |

No unconditional “one capture always equals one order” statement: scope the invariant to this reference merchant's lifecycle contract. No production certification, endorsement, exactly-once external payment guarantee, AI superiority or universal integration coverage.

## 3. Alternatives and chosen presentation

Choose a concise README entry for two distinct paths, with detailed material in dedicated documents. A complete README replacement risks erasing working V2 instructions; adding only a promotional paragraph obscures provenance. Retain existing instructions, correct overbroad introductions, and clearly separate current qualification from historical deployment facts.

**Owner demo-lead decision (2026-11-03): V2 first** — genuine recorded Sandbox observation, AI investigation and merchant-only recovery, followed by Lab as trust evidence. Owner explicitly selected this in the follow-up answer. Both paths distinguish the evidence sources and include the PayPal/AI story; the synthetic Lab alone does not demonstrate genuine PayPal use or AI. Missing V2 recording is a release blocker to resolve with the owner, not permission to drop that segment by default.

Plan the V2 recording in CP2 by Nov10 with recording authorization requested by Nov8. That request must name local versus hosted run, exact environment/identity, an existing Sandbox observation versus a new checkout, merchant mutations and human approval, numeric model/PayPal call caps, zero-spend enforcement and unavailable/quota fallback. Default call allowance remains zero until authorized. Prefer reusing an approved genuine observation to avoid a new financial action; any new Sandbox checkout/capture still requires separate approval. Fresh AI, cached AI and approved historical recordings must be labelled distinctly. Never simulate a successful live call/payment or change a cached result into a fresh claim. An approved existing recording may avoid new service calls, but must be checked for provenance and redaction. Do not visit hosted pages that may trigger sessions/model calls under planning/local validation authorization.

## 4. Exact proposed changes after approval

| File | Planned change |
|---|---|
| `README.md` | Bounded V3 overview; two-path navigation; local static lab build; historical experiment reproduction prerequisites; runtime/source identities; limitations and links; retain V2 setup/recovery instructions |
| `docs/V3_CLAIMS.md` (new) | Claim-to-source register with status, exact evidence location/hash, date/runtime, permitted wording, exclusions and publication blockers |
| `docs/V3_REPRODUCTION.md` (new) | Separate publication build from historical Gate A execution; clean checkout prerequisite, frozen install, exact commit, recorded scripts, exit capture, two accepted matching runs and successful cleanup; no claim of public availability |
| `docs/V3_DEMO_SCRIPT.md` (new) | Owner-selected V2-first or Lab-first narrative, both evidence paths explicitly labelled, timed shots, separately authorized V2 recording, failure fallback and cut list |
| `docs/V3_SUBMISSION_DRAFT.md` (new) | Problem, delivered solution, implementation, limitations and tool disclosure; explicit DRAFT and unverified fields; no invented video/source links, metrics or team claims |
| `docs/V3_RELEASE_GATES.md` (new) | Owner checklist for clean build/public source/runtime labels, independently checked competition rules, video/accessibility, source/license and hosted access through Dec15; named owner, daily monitoring and incident procedure below; links existing release checklist without replacing it |
| `tests/v3-docs.test.ts` (new, only if needed) | Focused offline contract checks for critical claim boundaries, local documentation links and real script references; never brittle paragraph snapshots or a self-certification of truthful prose |

No changes to package/lockfiles, dependencies, environment/config, SDK/verifier/manifests, eight public evidence JSON files or `docs/evidence/lab/README.md`, W1 code/UI, CI, hosted infrastructure or existing judge behavior. If source-availability UI needs updating, present a separate reviewed change; W4 cannot flip W1's `NOT_VERIFIED` literal or rewrite historical provenance. No new scripts unless an acceptance gap is reviewed first.

## 5. Checkpoints and implementation sequence

### CP0 — this plan

Deliver this plan and `.work/v3/w4/checkpoint-0/REPORT.md`. Claude reviews scope/claim boundaries and execution gates. Stop for PASS, owner planning commit and separate implementation authorization. Planning permission does not imply CP1 permission.

### CP1 — documentation vertical slice

1. Recheck HEAD/status, W1 sealed source inventory, old verifier manifest and public artifact hashes; capture baseline. Read actual command implementations before writing instructions. **Before finalizing script length or submission structure, perform a read-only primary-source check of the official competition Devpost rules/submission page**: deadline/timezone, video duration, required fields, repository visibility/license, judging criteria and access period. Record exact URL, retrieval date and supporting excerpts within quotation limits. Discover the official event link from existing rule references; do not substitute a similarly named contest. Inaccessible/conflicting rules are BLOCKED and require clarification, never a silent assumption. No sign-in, submission or account changes. The dates below are RECORDED_NOT_REPRODUCED from project/review records until this CP1 check; adjust the critical path if official rules differ. Build the claims register with no stronger assertion than its source.
2. For any behavior/check added, write the meaningful test first and show intended RED, then implement and GREEN. Pure prose edits require source/link/claim inspection rather than artificial tests. If adding the optional offline checker, start with broken local links, nonexistent script and conflated-evidence fixtures; show failures before fixing. It must not execute README commands, fetch URLs or load credentials.
3. Edit README and write reproduction guidance, script, draft and release gates. Distinguish an output source comparison from an applied AI patch. Keep public source unavailable and uncommitted-preview labels honest. Preserve retained historical timeout evidence; do not discard it because later runs passed.
4. Validate relative documentation links/anchors and every referenced package command against the actual checkout. Only allowlisted local checks run; never execute a whole Markdown code block automatically. Local static publication build uses `pnpm build:frontend`, with environment-file loading disabled as W1 requires. Run the existing packaged route/download check through its documented entry after inspecting its CLI. No owner setup, hosted startup, verifier stress run, model or PayPal call.
5. Run both typechecks and relevant W1/document tests; full regression only if code/tests changed or checks expose a concern. Supported Node22 validation uses the current-source W1 validator only if its inventory covers every relevant changed build input; otherwise report the coverage gap and propose a reviewed validation adjustment. Do not count an old image as validation of changed code. New Markdown checks may be run under a recorded runtime; do not falsely claim W1's frozen inventory includes them.
6. Rehearse the packaged static lab and owner-selected narrative with a stopwatch and keyboard navigation. Record accessible labels, disclosures and every planned shot. Target narration **at most170 seconds**, subject to the CP1 official video-limit check; actual recording length is NOT_TESTED until a video exists. An unrehearsed V2 segment remains explicitly NOT_TESTED and must be recorded/verified in CP2; do not omit it automatically. Request its bounded authorization by Nov8. Any networked demonstration needs separate authorization.
7. Inspect public docs for private paths, secrets, genuine identifiers and unverified external links; record hashes/commands/results. Confirm W1/Gate A identities unchanged. Stop at `.work/v3/w4/checkpoint-1/REPORT.md`, Claude review and owner commit. No recording/upload/submission/release implied.

CP1 acceptance: owner demo-lead selection recorded; official primary rules checked and submission structure/timing matched; every material public claim has a status and source; synthetic/Sandbox and human/AI boundaries explicit; commands exist and permitted local build works; actual packaged `/lab/`, judge navigation and downloads remain intact; local links resolve; source availability stays unverified; historical pins/records unchanged; no false completed W2/W3 claim; rehearsal within budget or cut before review. Unavailable hosted/AI/video checks are listed as NOT_TESTED, not passed. CP1 must carry a dated CP2 recording/release task rather than hide it as optional.

### CP2 — final readiness materials (separate future authorization)

Prerequisites: CP1 PASS/owner commit and owner-authorized release scope. Incorporate only completed W2/W3 results. Reconfirm the CP1 official rules check before final submission for changes; it is not deferred to CP2 for the first time. Obtain owner-approved assets/team/tool disclosures. Request bounded recording permission by Nov8 and record/review the chosen V2-plus-Lab narrative by Nov10; existing execution authorizations for W2 do not cover this recording or its service calls.

Verify exact source S through an unauthenticated public request, not authenticated connector visibility or a moving branch tip. Also check the exact publication commit needed for the lab, license and documented paths. A failed check keeps public-reproduction claims HOLD. Push/visibility changes remain owner-only unless specifically authorized. Do not leak a local remote containing credentials into reports.

Build publishing artifacts from an owner-prepared clean checkout of the reviewed commit; record `git status`, source/build identities and packaged route/download checks. Never delete/stage unrelated files to manufacture cleanliness. A dirty working folder is a preview, not the published build.

Record video only after asset/redaction review and separate permission; inspect every frame/audio for private data and labels, captions/legibility, actual duration below180seconds and truthful offline/recorded/live status. Verify hosted judge access separately with the owner's approved procedure; no financial/model action inferred. If it cannot be verified, disclose the limitation and use an approved local fallback rather than claim success. Upload, deployment and submission each require specific permission. Final report may be HOLD; no mandatory completion claim.

## 6. Regression, resources and scheduling

W4 adds no runtime resources to W2. Schedule any local build/test/container validation outside W2's capacity experiment and qualification; no parallel Docker build on the8GB laptop. Draft writing/source inspection can overlap. Do not change WSL/Docker settings or stop other workloads.

Work ASAP with no internal W2 cutoff; the external submission deadline still governs W4. Recorded deadline: **Nov12 2026 noon Pacific Standard Time = Nov13 2026 01:30 IST**, pending the mandatory CP1 official-rule verification. Recorded judge-access obligation: through **Dec15 2026 inclusive**. The following are proposed latest-start/completion milestones, not permission to execute external actions or guarantees that they have happened. All dates below are IST unless explicitly stated; if a gate slips, escalate the same day with an owner decision and smaller truthful scope, rather than silently moving the external deadline.

| Task | Latest start | Completion / buffer |
|---|---|---|
| W4 CP1 rules check, docs, chosen narrative and review | Nov4 | Nov5; retain Nov6 for review fixes/owner commit |
| Owner source push, exact S and publication P unauthenticated availability checks | Nov6 | Nov7; failed availability blocks public-reproduction claims |
| Owner-authorized clean hosted build/redeploy including `/lab/`, regression/access checks | Nov7 after reviewed source | Nov8; retain Nov9 for fixes; do not deploy under planning authorization |
| Owner recording authorization, assets, local/hosted choice and numeric call caps | Nov8 | Before first recording or service call |
| Record/review/redact/caption V2-plus-Lab video | Nov9 | Nov10; length checked against official limit |
| Final Devpost fields, source/license/video/access checks; owner submit | Nov10 | Nov11 by23:59 IST; at least25h31m before recorded official close; Nov12 reserved for submission issues |

W2/W3 results join the material only if independently PASS-reviewed and owner-committed before the Nov10 content lock; otherwise describe them as in progress/NOT_TESTED and retain the verified V2/W1 story. Do not wait for AI migration value to create a valid submission. W2 has no new internal cutoff imposed by these publication milestones. If the recorded competition rules disagree, replace this calendar from the verified rules before CP1 PASS.

**Post-submission access responsibility:** propose the project owner as the accountable operator, to be explicitly acknowledged at release sign-off. From submission through Dec15 inclusive, check daily by12:00 IST and after any release/provider incident: static judge and `/lab/` routes/assets/downloads, API health and one dedicated judge-session/read-only case journey under a separately authorized monitoring procedure. Do not run daily model/PayPal/repair actions or touch another judge's session. Record timestamp/results in ignored release logs; retain the judge URL, required data/session compatibility and access configuration through the period. On failure, notify the owner promptly and use only owner-approved recovery/redeploy steps. Availability cannot be certified by a plan or a single check. No automation, account change, service call or deployment is created by this proposal; lack of an acknowledged operator/check procedure keeps the release gate HOLD.

Keep a static fallback needing neither new model nor payment access, explicitly labelled; it is not a substitute for an unverified required hosted-access obligation or evidence of a fresh V2 AI run.

## 7. Reporting and review

Each report follows `AGENTS.md` §7 and handoff §7: VERIFIED versus RECORDED_NOT_REPRODUCED/NOT_TESTED, exact changed paths, commands/exits, evidence hashes, RED/GREEN/mutation evidence where applicable, deviations, skipped checks, top risks, ₹0 spend/inference0, Git status and next authorized action. Include owner-only scoped commit commands after PASS. Never commit automatically.

Claude should challenge claim inflation, confused synthetic/Sandbox provenance, unjustified AI language, stale-image validation, public-source assumptions, clean-build identity and preservation of V2 guidance. CP1 docs are not public-release approval.

Inputs needed now: none; owner explicitly chose V2-first. No environment variables, API keys, account access or new services are needed for planning. Future CP2 needs owner-approved assets, source-release/recording decisions and bounded service-call authorization; release sign-off also needs the monitoring operator's acknowledgement.
