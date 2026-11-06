# V3 release gates — owner checklist

Status: HOLD for public release/submission. W4 CP1 prepares documents; it does not approve deployment, recording, model/PayPal calls, Git writes or submission. Read alongside the existing [release checklist](RELEASE_CHECKLIST.md), which retains earlier gate history.

## Rules and calendar

Official [rules](https://paypalaihackathon.devpost.com/rules) and [schedule](https://paypalaihackathon.devpost.com/details/dates) checked read-only on 3 November 2026. Deadline is **13 November 2026 01:30 IST**; judging ends **15 December 2026 21:30 IST**. Video must be under 3 minutes on public YouTube; project needs meaningful Sandbox/AI use, functional access, public licensed source and description. English materials/translation required. Criteria are equally weighted: implementation, design, impact, innovation and presentation. Exact authenticated form fields and entrant eligibility are still owner checks. No calendar conflict with the reviewed plan was found. Recheck the official pages before final submission; a prior rules check is not a registration or eligibility certification.

| Latest start → completion, IST | Owner/reviewer gate | Current status |
|---|---|---|
| Nov 4 → Nov 5, Nov 6 review buffer | W4 CP1 claims/docs/script review, then owner commit | In progress; this checklist is a draft |
| Nov 6 → Nov 7 | Owner-authorized public source; exact S and publication P unauthenticated checks | HOLD; no push authorized here |
| Nov 7 → Nov 8, Nov 9 fix buffer | Owner-authorized clean build/redeploy and actual access check | NOT_TESTED; no deployment authorized here |
| By Nov 8 | Exact recording environment, existing footage/observation and numeric call caps approved | Not authorized; model/PayPal allowances 0 |
| Nov 9 → Nov 10 | V2-first video recorded, redacted, captioned and reviewed; content lock | NOT_TESTED |
| Nov 10 → Nov 11 23:59 | Owner fills/verifies form, submits and retains receipt | Not submitted; leaves 25h31m to recorded close |

Escalate any slip the same day; do not silently move the external deadline. W2/W3 may enter claims only if PASS-reviewed and owner-committed before the Nov 10 content lock. Otherwise describe their actual unfinished state. W2's ASAP/no internal cutoff decision remains separate from submission timing.

## Evidence and build

- [ ] The static Lab is supporting evidence, not the functional demo. Provide the working application and setup plus the test access or Sandbox details judges need, without publishing owner/production secrets. If a required access detail cannot safely be public, arrange an approved scoped test-access procedure.
- [ ] Verify the open-source license is detectable and visible in the public repository's About area; the local MIT file alone does not verify that display.
- [ ] Owner confirms team/representative, eligibility and rights; exact required fields checked on the authenticated form. No secret is placed into public instructions or a video.
- [ ] Review [claims](V3_CLAIMS.md) against actual release. Preserve genuine stored Sandbox evidence versus controlled merchant faults versus synthetic Lab; distinguish human reference fix from AI migration. Retain earlier failed/timed-out evidence alongside later successful runs.
- [ ] Owner makes source available under the approved license. Check exact `fc85ac3db1388bd84a3a55b8198d9dc3b2ad6c86` and the final publication commit without authentication. A branch tip or private connector is insufficient. Save dated URLs/status evidence. Failure keeps public reproduction HOLD.
- [ ] Any W1 label change from fixed `NOT_VERIFIED` needs a separate reviewed code change and new availability evidence. Do not modify historical JSONs to imply a new experiment.
- [ ] Owner prepares clean checkout at reviewed release commit; record status/source/build identities. Build/verify packaged `/lab/`, judge/owner navigation, assets and eight exact-byte downloads. Unrelated untracked files mean preview; never delete/stage them merely to obtain a clean label.
- [ ] Record candidate versus controller/runtime versions honestly. A W1 image validates its admitted build inputs, not excluded W4 prose or a deployed backend. Current W4 build/test evidence is in the checkpoint report, not assumed from old logs.
- [ ] Independently review docs/diff, secret disclosure, dependency/asset licenses and current supported-runtime evidence before owner commit/release. No automatic Git writes.

## Recording and actual app access

- [ ] Owner approves local/hosted environment, observation/footage, merchant mutations/approval, model and PayPal numeric caps, zero-spend protection and stop conditions. No new payment is inferred from recording approval; default service-call allowance 0.
- [ ] Before recording, owner resolves permissions for third-party trademarks, including PayPal marks/UI, as well as other copyrighted assets. Do not infer permission from this checklist or from using Sandbox.
- [ ] Video shows the actual project working end to end and explains its problem, intended audience and why it matters. A mockup, static prototype or non-functional demo cannot satisfy functional access.
- [ ] Final V2-first recording shows the actual app, evidence labels, real inference status, exact approval and merchant-only receipt; Lab follows as distinct synthetic trust evidence. Missing V2 footage blocks this narrative. No fake live result or automatic silent omission.
- [ ] Inspect final duration, every frame/audio, captions/legibility and rights; no credentials, private paths or full genuine identifiers. Only after separate permission upload and verify actual video access.
- [ ] Verify final hosted app and `/lab/` after owner-authorized deployment. Check a dedicated judge session's complete journey under its exact allowed action budget. Static route success alone is not a working backend/AI/recovery rehearsal. Do not touch another judge's session.
- [ ] Confirm complete local setup remains usable as a contingency. Static Lab alone does not replace the functional V2 application story. Unavailable model/quota/host states must remain visible.

## Access through 15 December 2026

**Accountable operator proposed: project owner. Acknowledgement is pending and required before release sign-off.** Keep hosted judge access available through 15 December inclusive (stronger than the exact end time above), without cost or judge restrictions. This is an obligation to operate, not a promise already established by tests.

After submission, operator checks daily by 12:00 IST and after any release/provider incident: static judge and `/lab/`, assets/downloads, API health and a dedicated judge-session/read-only case journey. Monitoring requires a separately approved procedure; no daily model/PayPal/repair actions, artificial keep-alive loop, paid fallback or new automation is authorized. Do not read historical private sessions or expose monitoring credentials.

Retain dated results/incident notes privately in ignored release logs. Report failures promptly to the owner; recover/redeploy only under an approved action. Preserve required session/data compatibility and free-tier headroom; freezing UI assets alone cannot prove availability. Missing operator acknowledgement, an untested procedure or inaccessible project keeps the corresponding gate HOLD. Final submission receipt and access evidence require owner/reviewer inspection.
