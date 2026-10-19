# Stage 1D — local merchant repair results

Date: 19 October 2026. Original implementation base: `5404f88`; bounded follow-up base: `edb4dc51608c4b045e3f683231b0459178dfccd8`. STATUS: Stage 1D implementation accepted and verified offline under simulated approvals; **Gate 1 remains incomplete**. Real interactive human-approved actual-evidence repair demonstration is pending.

## Verified implementation

- `src/db/repair-schema.ts`: additive migration 6, append-only plans, approvals, execution identities, transitions, unique terminal outcomes, merchant voids, incident resolutions and audit. New merchant inserts require matching COMPLETED capture status, captured amount/currency, intent/order/capture/SKU and organization. Existing historical records are preserved.
- `src/merchant/repair.ts`: canonical immutable facts and plan hashes; distinct declared requester/approver; 15-minute expiry; fresh evaluation; deterministic keeper by `(created_at,id)`; refusal of mismatched/uncertain evidence; independent executor checks. `execute(planId)` receives no approval flag, hash, or operator assertion. Organization is bound on the service, as local scope only.
- Execution uses BEGIN IMMEDIATE and a correction savepoint. Refused/failed corrections have no void or resolution effects. Result and audit commit together. Unique plan execution and terminal outcome enforce idempotency across processes/restarts. A crash before commit leaves no durable invocation; retry revalidates. After commit, retry returns the same outcome. This supersedes the former two-transaction failure journal design.
- `src/merchant/{contract,checker,repo,api}.ts`: checker and API use effective active orders, keeping original `status` and incident records immutable. API adds `effectiveStatus`, `historicalState`, derived resolution state, and scoped read-only history. Multi-injection provenance does not claim one injected race caused a duplicate when orders reference different injections.
- `src/merchant/repair-cli.ts`: explicit isolated database required; protects original path, symlink and same-file identity before Store construction; TTY-only exact-plan approval and typed suffix; no simulation CLI switch. Missing/invalid arguments exit 2, durable execution refusals exit 3. No HTTP repair mutation endpoint.
- `LOCAL_DEMO_DECLARED_OPERATOR` is explicitly unauthenticated. Same declared person may request/approve; separation of duties is not enforced. Anyone with database write access can forge declarations. This is not real RBAC or exposure authorization.
- No provider client/config/runtime dependency exists in repair. No payment attempt or provider evidence mutation is part of repair logic.

## Commands and observed evidence

All tests use isolated temporary/synthetic databases. All actual-evidence workflow work used isolated byte copies. No new Sandbox order/capture/refund/resend/tunnel or AI evaluation was performed.

| Check | VERIFIED result | Local evidence |
|---|---|---|
| `pnpm test` | **392/392**, 18 files, 0 failed; 335 prior tests preserved + 57 new | `.work/runs/stage1d/20-full-suite.txt` |
| `pnpm typecheck` | exit 0 | `21-typecheck.txt` in same folder |
| `pnpm build:web` | exit 0 | `22-web-build.txt` |
| Targeted Stage 1D suite | 55 repair tests + 2 schema tests, all included in full run | `20-full-suite.txt` |
| Targeted mutations | **12/14 killed; 2 survivors**, 0 harness errors | `mutations/results.json` and individual logs |
| Fresh read-only code review | one integrity/audit finding reproduced RED and fixed GREEN | `14-review-red.txt`, `15-review-green.txt` |
| CLI refusal exit code regression | RED then GREEN | `17-cli-red.txt`, `18-cli-green.txt` |
| Heuristic changed-file secret scan | 0 matches; does not certify absence of all secrets | `25-secret-scan.json` |
| `git diff --check` | exit 0 | final verification session |

The only existing-test change is the migration-version assertion in `tests/stage1c-corrections.test.ts`: literal v5 → `MIGRATIONS.length`, preserving the row-preservation/refusal assertions. No dependency or lockfile change.

### RP1–RP13 coverage

| Contract test | Evidence in `tests/stage1d-repair.test.ts` / schema test |
|---|---|
| RP1 | Simulated test approval → successful local void → HOLDS/one effective order/resolution; exact historical/provider/fault preservation; actual CLI on synthetic TTY fixture separately |
| RP2 | Same-plan duplicate calls; two independent OS processes contend under a writer barrier on one SQLite database; second preexisting approved plan refused after resolution |
| RP3 | Missing approval, wrong hash/typed suffix, corrupted assurance/hash, consumed refusal, immutable/edited plan, rehashed wrong keeper/voids, edited facts; reviewer regression for edited incident reference |
| RP4 | New order; additional confirming readback; contradicting REFUNDED readback; capture ID/status, amount/currency and PayPal order ID changes |
| RP5 | Exactly 900000 ms TTL; exact expiry boundary rejected |
| RP6 | Legacy capture/amount/currency/SKU/PayPal order mismatches refused, including two matching orders plus a mismatched third |
| RP7 | Injected exception; genuine non-HOLDS post-state; extra mismatched active order; attempt mutation in eligible and non-contract fields; correction rollback and durable terminal refusal |
| RP8 | Wrong org plan/approval/execute/history refused; unrelated healthy intent unchanged |
| RP9 | Update/delete guards on all eight repair tables; unauthorized/keeper void refused; resolution requires scoped later HOLDS/keeper; migration rejects bad/null completed capture facts |
| RP10 | Close/reopen after approval; real SIGKILL after begin, voids, postcondition, rollback, before commit, after commit; restart observes all-or-nothing and returns one terminal result |
| RP11 | Provider/merchant/fault/incident byte-equivalent row snapshots; no single-injection claim for differing fault IDs; copy evidence hashes below |
| RP12 | POST/PUT/PATCH/DELETE repair routes return 405; header provides no approval capability; service/CLI have no HTTP identity input |
| RP13 | Runnable `node tests/helpers/stage1d-mutations.mjs`; see survivors below |

Network checks include throwing fetch and HTTP/HTTPS request spies, a forbidden provider-construction mock and a static import-boundary check. These are offline regression evidence, not production network-isolation certification.

### Mutation survivors (explicit)

Initial pass: 10/14 killed. Added independent wrong-keeper-only and non-contract provider-field regressions; final pass: 12/14 killed. Full source restored after every mutation.

- **R08 SURVIVED**: deleting the executor's HOLDS/count/keeper postcondition expression still results in refusal because the independent SQLite resolution trigger rejects the non-HOLDS evaluation. No bad resolution or void commits. This survives as defense in depth, not evidence that the expression was tested independently of the DB.
- **R10 SURVIVED**: deleting the explicit resolved-incident check still refuses a second repair because the facts snapshot includes the resolution and the approved facts hash no longer matches. The test checks behavior, so this redundant guard is not independently distinguished.

Other killed variants: plan/facts integrity, approval presence, approval hash, identity assurance, expiry, stale facts, keeper, void set, eligibility/mismatches, provider preservation, idempotent result return and savepoint rollback. No claim of 100% mutation coverage.

### Actual terminal versus simulated approval

Most tests persist **SIMULATED_TEST** and use a test-only method guarded by `NODE_ENV=test`. The production CLI never offers that method.

A separate **fabricated synthetic** SQLite fixture exercised a real terminal (`stdin.isTTY` and `stdout.isTTY`), real readline prompt, wrong typed confirmation (refused), then correct typed suffix (accepted). Its operator is `AUTOMATED_SYNTHETIC_TTY_TEST_NOT_HUMAN`, with `INTERACTIVE_TTY` approval mode. The agent typed the test response. This proves terminal behavior, **not human consent**, real payment evidence or real identity. A subsequent CLI execution on that synthetic fixture succeeded with unchanged provider hashes. See `.work/runs/stage1d/tty-observation.txt`, `19-synthetic-tty-execute.txt`, and `.work/stage1d/tty-test/`.

## Isolated actual-evidence copies and review plan

Command:

```powershell
pnpm stage1c --source .work/ordertruth.sqlite --out-dir .work/stage1d/review --report-dir .work/runs/stage1d/offline --target-order 7TS74882M0297892Y
```

VERIFIED healthy copy: 2 orders, 2 HOLDS, 0 incidents. Fault copy: 3 orders, 1 HOLDS + 1 VIOLATED, 1 incident; cross-org detail 404. Eight non-eligible intents remain non-eligible in both copies. The fault remains labelled CONTROLLED_FAULT_INJECTION and provider evidence remains distinct.

Original `.work/ordertruth.sqlite` SHA-256 before/after:
`390fe8d8c12a8b787480158420355f940fc7aeb4e25ae0954cafcc461b16b1bb`.
A byte-identical isolated source snapshot reports schema v3. Review copies report v6. No source WAL exists. The original was not opened through Store or migrated.

Full sorted row hashes are equal between the isolated v3 snapshot and fault review copy for **payment_attempts, evidence, webhook_deliveries, webhook_events and attempt_transitions**. Values are in `.work/runs/stage1d/24-final-evidence.json`. This verifies preservation of actual recorded provider evidence; it does not perform a fresh PayPal readback.

**Ready plan, UNAPPROVED and UNEXECUTED:**

- Database: `.work/stage1d/review/fault.sqlite`.
- Plan: `rp_c827add8-19a6-4ebf-af5d-114173474591`.
- Hash: `151eae30c5c98808a0fb22ff1ad307f50594d365526f2c970fa7685b1b9030c3`.
- Incident: `inc_ae053acb-97f7-4bb8-9122-49a7a80c8377`.
- Keep: `mo_9889eeaf-2f58-43ab-9452-318583bdd8d5`.
- Planned local void: `mo_045628a3-7e9f-419d-b87b-09c5aa496f8c`.
- Declared requester: `LOCAL_DEMO_PLAN_REQUESTER_CODEX`; no approver exists.
- Created: **19 October 2026 09:31:09.765 IST**. Expires: **09:46:09.765 IST** (04:16:09.765 UTC).
- Exact stored facts: `.work/stage1d/review/ready-plan.json`.
- VERIFIED: **0 approvals, 0 executions, 0 voids, 0 resolutions** in this review copy.

Inspect without approval:

```powershell
pnpm repair show --db .work/stage1d/review/fault.sqlite --org org_reference --plan rp_c827add8-19a6-4ebf-af5d-114173474591
pnpm repair history --db .work/stage1d/review/fault.sqlite --org org_reference --incident inc_ae053acb-97f7-4bb8-9122-49a7a80c8377
```

An expired plan is review evidence only. After independent review and separate demo authorization, create a fresh plan, inspect its exact hash/facts, and have the human run interactive approval for that exact plan. Approval is never inferred from this report. No approval/execution commands for this actual-evidence copy were run.

## Limits, costs and stop boundary

NOT_TESTED: human-approved actual-evidence repair demonstration; fresh Sandbox/provider behavior; production authentication/RBAC; public deployment/judge access; Gate 2/AI evaluation; disk failure/host hardware fault certification. Hard-kill tests cover process crashes on this local SQLite/runtime version, not every storage failure.

Top risks: (1) declared identities can be forged by local DB writers—keep local/unexposed; (2) 15-minute plans expire during review—regenerate and re-review exact plan after authorization; (3) two mutation guards are masked by independent safeguards—report survivors and preserve both layers.

COST / QUOTA: ₹0 incremental service spend; no new dependency/service or provider calls. Agent inference token/cost accounting unavailable. Optional community lookup returned not connected; no community claims are relied on.

BLOCKING QUESTIONS: none for implementation. NEXT ACTION: independent review; then separately authorized human interactive repair demonstration. GIT (original checkpoint): no Git writes by Codex or reviewer. The bounded follow-up below has separate explicit commit/push authorization. Gate 1 is not marked complete.

## Bounded independent-review follow-up (19 October 2026)

IMPLEMENTED: `src/merchant/repair.ts` hashes a deterministically ordered provider snapshot for both approval staleness and execution postconditions. It covers full attempt rows and their evidence (including PayPal API responses/readbacks), associated webhook events with a verified first delivery, verified first/duplicate deliveries, associated unassigned verified-webhook evidence, webhook state audit rows, and the shared immutable `attempt_transitions` rules. This last table defines allowed state transitions; it is **not a per-attempt transition history**. No new history or migration is implied.

Association is scoped through the attempt's organization and identity. An event's explicit attempt link takes precedence; only unlinked events may associate by the intended PayPal order ID. Event verification requires a matching verified first delivery. A claimed event ID alone never brings an unverified delivery into the snapshot. Unassigned webhook evidence must name both the associated event and its first delivery. Invalid plan references are not dereferenced; integrity refusals hash provider records in the service's bound organization plus shared transition rules. Ordinary repair never updates original merchant-order rows; void records determine effective status.

VERIFIED offline (synthetic databases and simulated approvals only):

| Command | Observed result | Local evidence under `.work/runs/stage1d-followup/` |
|---|---|---|
| `pnpm test` before edits | 392/392 baseline passed | `01-baseline.txt` |
| `pnpm exec vitest run tests/stage1d-repair.test.ts -t 'provider preservation'` before fix | 7 failures: missing protection/staleness; 2 controls passed | `02-red.txt` |
| Same targeted command after fix and added controls | 13 passed, 54 unrelated tests filtered out | `06-adversarial.txt` |
| `pnpm test` after correction | 404/404 passed, 18 files; 392 baseline + 12 new | `07-full-suite.txt` |
| `pnpm typecheck` | exit 0 | `04-typecheck.txt` |
| `pnpm build:web` | exit 0 | `05-web-build.txt` |
| `pnpm exec vitest run tests/stage1d-repair.test.ts tests/stage1d-schema.test.ts` | 69/69 passed | `09-targeted.txt` |
| `node tests/helpers/stage1d-mutations.mjs` | 12/14 killed; R08/R10 survived; zero harness errors | `08-mutations.txt` and `.work/runs/stage1d/mutations/results.json` |
| `node .work/runs/stage1d-followup/scan.mjs` (also `--staged` before commit) | 5 scoped files, zero heuristic findings, zero forbidden paths; no secret/private-evidence files read | `11-secret-scan.json`, `12-staged-scan.json` |
| `git diff --check` / `git diff --cached --check` | exit 0 | final verification session |

The new savepoint regressions tamper with event content/association, delivery content/association, a verified duplicate, unassigned webhook evidence, webhook audit, and shared transition rules. Each proves `FAILED_POSTCONDITION`, full provider-row restoration, zero merchant voids, zero incident resolutions and one durable refusal. Controls cover stale approved webhook facts, unlinked associated events, unrelated events/unverified claims, and a different organization's explicit attempt binding despite a claimed matching order ID. Where an append-only trigger normally blocks tampering, the test drops it inside the savepoint to exercise the preservation guard; rollback restores it too.

Mutation survivors R08 and R10 remain explicitly reported above; no cosmetic mutation-score improvement is claimed. The original results table remains the historical 392-test checkpoint, distinct from this follow-up.

VERIFIED read-only file hash: original `.work/ordertruth.sqlite` SHA-256 still equals the recorded `390fe8d8c12a8b787480158420355f940fc7aeb4e25ae0954cafcc461b16b1bb`. It was not opened through Store or migrated. This file hash alone is not a logical/WAL-state assertion.

NOT_TESTED / stop boundary: no real interactive actual-evidence repair, no PayPal calls or financial mutations, no original database Store open/migration, no actual-evidence plan creation/approval/execution, no Gate 2, AI evaluation or UI expansion. The old ready plan expired at 2026-10-19 04:16:09 UTC and must never be approved or executed. A fresh unapproved/unexecuted plan belongs to a separate step **after** the correction commit and independent-review report.

COST / QUOTA: ₹0 incremental service spend; no new dependencies or external service usage. Agent inference accounting unavailable. Optional community lookup returned not connected; no community claims are relied on. NEXT ACTION: stop after the authorized scoped commit/push and final verification report for independent review.
