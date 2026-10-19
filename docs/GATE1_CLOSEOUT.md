# Gate 1 closeout and Gate 2 handoff

Date: 19 October 2026. STATUS: **GO — user-accepted scoped Gate 1 closure** for the local reference-merchant vertical slice. Gate 2 is not implemented by this closeout. This is not production, authenticated-identity, hosted-judge-access or complete-product certification.

Reviewed implementation/base SHA: `ce861c1c90b3eedfd99d5ff20235992e6b97de6b`, matching local HEAD and remote main before closeout. The commit containing this document identifies the closeout changes (`git log -1 --format=%H -- docs/GATE1_CLOSEOUT.md`); the final commit/push receipt is local `.work/runs/gate1-closeout/FINAL.md` and the delivery message. A document cannot contain its own resulting commit hash.

## Passed gate boundaries and evidence

| Gate | Accepted evidence and boundary |
|---|---|
| Gate 0 | Sandbox capture/readback and free-tier AI feasibility; historical results in `GATE0_FEASIBILITY_REPORT.md`. RECORDED_NOT_REPRODUCED during closeout; no renewed provider/quota claim. |
| Gate 1A | Local payment recovery, timeout/restart/concurrency checks in `GATE1A_RESULTS.md`; provider mocks are distinguished from live evidence. |
| Gate 1B | One genuine Sandbox checkout and first verified webhook deliveries/readbacks in `GATE1B_LIVE_RESULTS.md`; local security/verification tests in `GATE1B_SECURITY_AND_RESULTS.md`. No live retry/redelivery guarantee. |
| Stage 1C | Reference contract, explicitly controlled duplicate-order fault, deterministic incident and organization-scoped engineering/operations inspection in `STAGE1C_RESULTS.md`. Local organization scope is not authentication; live merchant-handler wiring and polished role UX remain outside the verified slice. |
| Stage 1D | Actual-evidence local repair passed independent post-execution verification, accepted by the user. Exact references below; no payment or repair demonstration repeated in closeout. |

Historical gate evidence is RECORDED_NOT_REPRODUCED here. Fresh closeout verification covers the offline suite, typecheck, web build and F3 clean-export regression, not renewed Sandbox or AI calls.

## Exact Stage 1D result

- Database: `.work/runs/gate1-human-demo-prep/actual-evidence-demo.sqlite` (isolated actual-evidence copy).
- Organization: `org_reference`; intent: `ci_b18b1fa3-fb92-407d-bd05-f39fd6ccf1f7`.
- Incident: `inc_ae053acb-97f7-4bb8-9122-49a7a80c8377`; effective state **resolved_verified**, derived from the append-only resolution. The immutable historical incident row remains open.
- Plan: `rp_fa8151bc-85ee-4edf-b448-0414c2bf0873`; exact SHA-256 `b3d3eeaa23482237757f2614662ac7a26044bc49c260adcc18e014a4136a1217`.
- Execution: `rx_8cac9691-642d-43fd-a813-24c47705440e`; persisted successful outcome at `2026-10-19T05:06:41.086Z` (10:36:41.086 IST).
- New post-repair evaluation: **14, HOLDS**, linked to the correct intent, keeper and execution.
- Exactly one effective placed keeper: `mo_9889eeaf-2f58-43ab-9452-318583bdd8d5`.
- Exactly one append-only local void: `mo_045628a3-7e9f-419d-b87b-09c5aa496f8c`. No original merchant-order values changed; comparison was canonical UTF-8 row bytes, not physical SQLite pages.
- PayPal order `7TS74882M0297892Y`; supported capture `79N705976G542051J`, COMPLETED USD 1.00. Stored readbacks 29/31/33/34 agree. No fresh provider verification was performed in closeout.
- One recorded **INTERACTIVE_TTY** approval at `2026-10-19T05:06:25.947Z` (10:36:25.947 IST); literal operator placeholder **YOUR_DECLARED_NAME**. This proves recorded mode/declaration only, not authenticated operator identity or independently proven human identity. No extra repair attempts.
- All six **complete-table** hashes unchanged: `payment_attempts`, `evidence`, `webhook_events`, `webhook_deliveries`, `webhook_audit`, `attempt_transitions`. Scoped outcome hashes are distinct from this independent full-row comparison.
- Original source and fault-source database families unchanged; integrity `ok`, no foreign-key violations.

Independent read-only inspection at `2026-10-19T05:10:16.330278Z` passed all ten requested checks plus plan/facts integrity and inspection source-family preservation. Local ignored evidence:

- `.work/runs/gate1-human-demo-prep/REPORT.md`: plan/provenance preflight and complete provider baseline hashes; `post-tables.json`: pre-execution table hashes; preserved snapshot: `preserved-fault/fault.sqlite`.
- `.work/runs/gate1-human-demo-verification/REPORT.md`: full PASS matrix and limitations.
- `.work/runs/gate1-human-demo-verification/verification.json`: persisted relationship checks, full hashes, counts and empty failure list.
- `.work/runs/gate1-human-demo-verification/read-source-baseline.json`: file-family preservation evidence.

These are local evidence locations, not tracked public fixtures. A clean checkout cannot reproduce the historical transaction without private evidence; do not fabricate or rerun the payment/repair to fill that gap. Original historical reports, plans and database records were not rewritten.

## F3 — clean-checkout fixture dependency: FIXED

Root cause: the old path-protection test called `isolatedDatabase('.work/ordertruth.sqlite')`, an ignored file absent in a clean checkout. `realpathSync` threw ENOENT before the test's expected protected-file refusal. This was a test-fixture dependency, not evidence that the CLI opened the original database.

Minimal fix: `isolatedDatabase` accepts an internal protected-path argument defaulting to the unchanged original path; CLI callers still always use that fixed default and expose no override flag. The test owns temporary synthetic files, checks direct path and hard-link alias rejection, permits a distinct same-content copy, and verifies the protected file remains unchanged. Existing CLI argument/non-TTY refusal assertions remain.

| Fresh command/check | Observed result | Ignored log under `.work/runs/gate1-closeout/` |
|---|---|---|
| Clean tracked export, old targeted test | 1 failed / 66 filtered: expected protected refusal, got ENOENT | `02-clean-red-direct.txt` |
| New synthetic test before helper fix | 1 failed / 67 filtered: protected fixture was not refused | `03-fixture-red.txt` |
| `pnpm exec vitest run tests/stage1d-repair.test.ts -t 'protected database guard\|CLI protects original'` | 2 passed / 66 filtered | `04-fixture-green.txt` |
| `pnpm test` | **405 passed, 18 files; 0 failed, 0 skipped** (404 baseline + 1 regression) | `05-full-suite.txt` |
| `pnpm typecheck` | exit **0** | `06-typecheck.txt` |
| `pnpm build:web` | exit **0** | `07-build.txt` |
| Clean export: `node D:/Projects/OrderTruth/node_modules/vitest/vitest.mjs run` | **405 passed, 18 files; 0 failed, 0 skipped** | `09-clean-full-green.txt` |

Clean-export method: read-only `git archive HEAD`, overlay only the two changed source/test files, no `.env` or evidence databases, existing installed `node_modules` reused through a directory junction. It proves the ignored-file dependency is removed; it is not a fresh install or different-host certification. Full commands ran offline with bounded test timeouts. Native SQLite emits its expected experimental-runtime warning.

Harness diagnostics retained honestly: pnpm's clean-export dependency check first refused an automatic modules refresh without a TTY, so the installed Vitest entry point was invoked directly; no install was accepted. An initial overlay used the wrong working-directory-relative destination and copied nothing; that old full export reproduced 403 passes / 1 F3 failure (`08-clean-full-suite.txt`). Correct absolute overlay paths then produced the clean 405/405 result. No evidence DB was created to manufacture a pass.

## F2 — conditional webhook provenance preservation: OPEN

The scoped `providerSnapshot()` joins associated events to a verified first delivery claiming the same event ID. A **pre-existing target-associated event with inconsistent or missing first-delivery provenance can be omitted** from that snapshot, together with related records. Protection against tampering with valid included events does not prove preservation of invalid omitted records. F2 is not fixed by `ce861c1`, by the successful demo, or by this documentation/test-fixture closeout.

The actual-evidence demo independently queried unfiltered associated events and passed the mandatory provenance preflight; both first deliveries, webhook evidence and audit chains were consistent. That bounds the accepted demonstration only. Do not generalize scoped preservation to arbitrary inconsistent databases.

Next hardening acceptance criteria (proposed work, not implemented or authorized here):

1. Independently enumerate target-bound events and unlinked events associated by PayPal order before applying verification filters. Define fail-closed treatment of missing delivery, wrong claimed ID, non-verified delivery, conflicting association and ambiguous evidence/audit links.
2. Add adversarial synthetic tests for invalid pre-existing provenance, proving no correction/resolution is committed and no relevant provider row can silently disappear from preservation checks. Preserve cross-organization isolation and unrelated/unverified-delivery negative controls.
3. Document precisely whether invalid provenance causes refusal or inclusion for preservation; never upgrade invalid records into verified capture evidence. Compare complete-table hashes independently in regression evidence.

## Gate 2 handoff — priorities only

1. Resolve F2 with fail-closed provenance tests before extending repair eligibility; keep one coherent local reference-merchant boundary.
2. After separate Gate 2 authorization, select at most two further incident classes with explicit contracts, grace periods and healthy negative controls; keep money actions prohibited.
3. Measure grounded AI against a no-LLM baseline with evidence-ID accuracy, latency, privacy and free-tier quota limits; show unavailable honestly. Gate 0 quota is historical, not a current availability guarantee.
4. Extend webhook/restart/security hardening, including real retry-window uncertainty and inbox concurrency limits. Authenticated RBAC/CSRF and role separation remain prerequisites for exposure; retain the declared-identity limitation until replaced and tested.
5. Preserve independent branding and complete engineering/operations interactions and accessibility; resolve reproducible setup and sustained judge-access/hosting through **15 December 2026** in the later release gate. No public deployment or judge-readiness claim follows from this local closeout.

Remaining risks: F2 OPEN; unauthenticated declarations/dev organization header; mutation survivors R08/R10 (12/14 killed historically); historical live retry/staleness uncertainty; merchant live wiring/UX and production/judge access not verified. No score or production certification assigned.

COST / QUOTA: ₹0 incremental service spend; no new dependencies, PayPal/AI calls, accounts or financial mutations during closeout. Agent inference accounting unavailable. No source `.env` content read or published. Only sanitized tracked documents/source/tests may be committed; actual evidence stays ignored.

NEXT ACTION: stop after scoped validation, review and authorized normal commit/push. No force push, additional plans, approvals, executions, payment demonstration or Gate 2 implementation.
