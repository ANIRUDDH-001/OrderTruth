# Gate 2A — F2 webhook provenance hardening

Date: 19 October 2026. Scope: F2 only. Starting HEAD and remote main:
`163275f0c15aa29df6e55c3914ffd6accfb98c9b`.

**VERIFIED: PASS for the synthetic, offline F2 acceptance boundary.** No PayPal calls,
new checkout, actual-evidence repair, AI work, dependencies, authentication or UI changes.
Gate 1 closeout remains historical evidence; this report does not recertify it.

## Root cause and invariant

Previously, `RepairService.providerSnapshot()` INNER JOINed events to a verified first
delivery with a matching claimed event ID before collecting preservation rows. An event
already pointing to an unverified delivery could disappear from the snapshot. Hash equality
then protected only the remaining rows, not the excluded event/provenance.

`src/merchant/repair.ts` now selects `candidate_events` from organization-scoped attempts
**before** testing first-delivery verification. Explicit `attempt_id` binding wins;
order-ID fallback applies only when `attempt_id IS NULL`. A delivery's unverified claim
alone never establishes scope. Every candidate must satisfy these local consistency checks:

- First delivery exists, is `verified` (not `duplicate`), and claims the same event ID/type.
- Event summary identity/type/resource type/create time/order agree with event columns.
  An explicitly bound candidate's order agrees with its bound attempt's PayPal order.
- Exactly one `PAYPAL_VERIFIED_WEBHOOK` evidence record links that event and first delivery.
  Evidence is selected by **either** event ID **or** delivery sequence, then both must agree;
  contradictory records cannot hide behind an AND filter. Summary, `paypal_postback` marker,
  `webhook_verified` operation, attempt binding (if present), debug ID, duration and correlation
  must agree with their source records.
- First-delivery audit records show receipt followed by verification. Event audit starts
  `verified_pending` and names the original first delivery. Both histories are continuous,
  use legal immutable `webhook_transitions`, and end in the persisted current state.

Only then does the existing verified-event selection assemble the preservation snapshot.
Healthy snapshot fields, ordering, row selection and canonical hash algorithm are unchanged.
No schema migrations, webhook repairs or provider writes were added. The validator executes
through the existing snapshot calls in planning, approval/staleness checks, execution,
the independent post-void postcondition and the final snapshot.

## Synthetic RED → GREEN evidence

All fixtures use temporary synthetic databases and conspicuous `SIMULATED_TEST` approvals.
No ignored private evidence file is required. In `tests/stage1d-repair.test.ts`, a healthy
synthetic inbox event is redirected to an existing unverified delivery using an ordinary
UPDATE with foreign keys and existing guards enabled. Against the original source, planning
unexpectedly succeeds: the refusal assertion fails with `expected [Function] to throw an
error`. After the fix, planning throws `webhook provenance invalid or contradictory; repair
refused`, without committing a plan, evaluation, merchant void or resolution.

The first broad RED run recorded **17 failed, 4 passed, 68 filtered**. The four already
passing controls do not count as newly fixed failures. Independent review then exposed two
additional gaps: an impossible but continuous audit chain, and a target-bound event whose
summary/evidence consistently name another order. Each had a separate observed RED before
its fix; both now refuse planning. The review found no remaining blocking findings after
those changes, and independently ran the final focused checks: **38 passed, 55 filtered**.

## Scenario behavior and refusal semantics

| Scenario | VERIFIED result |
|---|---|
| First link redirected to unverified or rejected delivery | Planning throws; no plan/evaluation committed |
| Missing first delivery | Planning throws; fixture deliberately bypasses FK for corruption, restores FK before repair |
| Wrong claimed event ID/type | Planning throws |
| Verified duplicate substituted for first delivery | Planning throws |
| Contradictory event summary/order or explicit attempt/order binding | Planning throws |
| Missing, conflicting, wrong-link, altered or ambiguous verification evidence | Planning throws |
| Wrong first-delivery audit linkage or invalid audit transition/history | Planning throws |
| Corruption before approval | Approval throws; no approval/audit committed |
| Corruption after approval, before execution | Execution throws; outer transaction rolls back execution/transition; zero voids/resolutions |
| Corruption inside correction savepoint | `FAILED_POSTCONDITION`; correction/provider tampering rolled back; one durable terminal refusal |
| Healthy first delivery, verified duplicate, unlinked order fallback, processed event | Repair succeeds; complete provider rows unchanged |
| Unrelated verified event, unverified delivery claiming target ID, other org's explicit event binding | Excluded from target scope; target repair succeeds |

The existing execution transaction needs a trustworthy pre-execution snapshot to create
terminal hashes. Consequently, pre-execution invalid provenance raises an exception and
leaves **no durable execution outcome**, rather than inventing valid hashes. This is a
documented refusal boundary, not a broad exception-handling redesign. Inside the correction
savepoint, the prior valid snapshot survives rollback, allowing the existing durable
`FAILED_POSTCONDITION` outcome. No webhook row is changed to make repair eligible.

Corruption fixtures retain all guards where practical. Missing delivery explicitly disables
FK only for setup. Altering/deleting append-only evidence or audit explicitly drops the
relevant guard only in the isolated synthetic fixture. Names/comments identify those
bypasses. The impossible audit chain uses ordinary inserts, without disabling guards.

Failure assertions compare independently selected **complete rows** of `payment_attempts`,
`evidence`, `webhook_events`, `webhook_deliveries`, `webhook_audit` and `attempt_transitions`,
not the service's snapshot hashes. They also check zero merchant voids/resolutions and,
where applicable, no committed plan/evaluation/approval/execution. Success controls compare
complete provider rows; existing regression tests cover original merchant row immutability,
expiry, concurrency, restart/crash, idempotency, authorization boundaries and no network.

## Exact validation

Ignored local logs: `.work/runs/gate2-f2/`.

| Check | VERIFIED outcome | Log |
|---|---|---|
| Starting tracked export, installed Vitest runner | 405/405 passed; 18 files; 0 failed/skipped | `baseline-clean-direct.txt` |
| Original focused reproduction | 1 failed; 68 filtered | `red.txt` |
| Original broader F2 checks | 17 failed, 4 passed; 68 filtered | `red-all.txt` |
| Review-driven audit and binding RED checks | Each 1 failed, remaining tests filtered | `red-audit-transition.txt`, `red-binding.txt` |
| `pnpm exec vitest run tests/stage1d-repair.test.ts -t 'F2\|provider preservation'` | 38 passed; 55 filtered; 0 failed | `green-focused.txt` |
| `pnpm test` | **430/430 passed; 18 files; 0 failed/skipped** | `full.txt` |
| `pnpm typecheck` | Exit 0 | `typecheck.txt` |
| `pnpm build:web` | Exit 0 | `build.txt` |
| Stage 1D repair + schema tests | **95/95 passed; 2 files; 0 failed/skipped** | `stage1d.txt` |
| Patched clean tracked export, installed runner | **430/430 passed; 18 files; 0 failed/skipped** | `clean-final.txt` |
| Existing mutation harness, isolated export | **12/14 KILLED, 2 SURVIVED, 0 harness errors** | `mutation-console.txt`, `clean-export/.work/runs/stage1d/mutations/results.json` |
| Scoped diff / whitespace | `git diff --check` exit 0 | Git inspection |

Mutation survivors remain **R08-postcondition and R10-resolution-stale**. This patch does
not claim either is fixed. R09 provider-preservation mutation was killed. The harness
restored its disposable source, whose SHA256 matches the working source. It did not mutate
the working implementation or any historical database.

Clean export uses `git archive` of the starting commit, then overlays just the changed
source and tests. No `.env` or private evidence databases are exported. Installed
dependencies are reused through a directory junction: **not a fresh install or different-host
certification**. `pnpm --dir ... test` first refused a no-TTY dependency refresh; no install
was accepted. Direct invocation of the installed Vitest entry point succeeded. An initial
overlay used paths relative to the export instead of the repository, failed to copy, and
reran the 405-test baseline; that output is retained as `clean-overlay-diagnostic.txt`, not
claimed as patched validation. Absolute overlay paths then produced 430/430. Node emits
its existing experimental SQLite warning.

## Limits, preservation and handoff

VERIFIED: all three protected historical database families (main/WAL/SHM existence and
SHA256) match their starting state. Those databases were not opened through SQLite or
migrated. Their private data and Gate 1 report files are not part of this change.
₹0 incremental service spend; no new dependencies, provider/AI calls, accounts or financial
actions. Agent inference usage/cost accounting is unavailable; no invented token metric.

NOT_TESTED: historical repair replay, fresh signature verification/readback, production
authentication, judge access, new live webhook behavior and other Gate 2 work. Local
consistency cannot detect an attacker coherently rewriting all database facts and guards;
it is not cryptographic re-verification. Existing declared identities remain unauthenticated.
Audit/evidence completeness is intentionally required for any scoped candidate; legacy
records missing that required provenance refuse instead of being silently excluded.

Handoff: F2's scoped offline acceptance checks pass. R08/R10, authentication and the
remaining Gate 2 items stay separate. Stop after the authorized F2 commit/push; require a
new scoped task before expanding Gate 2. Do not replan or rerun the historical repair.
