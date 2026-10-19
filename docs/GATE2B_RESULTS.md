# Gate 2B — Missing merchant order detection

STATUS: **Gate 2B; GO for this scoped offline incident class.**

Date: 19 October 2026 (IST). Starting main: `7e7b4aafb39ad1715255c85ca816d6e4cbfb9fe5`.
Environment VERIFIED: Windows, Node `v22.18.0`, pnpm `11.4.0`, installed dependencies; no new dependency.

## Delivered behavior

IMPLEMENTED: Exactly one additional incident class, `MISSING_MERCHANT_ORDER`. The checker reads
persisted payment/readback facts and organization-scoped effective reference merchant orders.
It performs no PayPal or AI call and creates no merchant order or repair plan.

The base duplicate-order evaluator, duplicate dedup key, and F2 repair provenance validation remain
intact. Missing incidents use the original org/contract/intent key plus `|MISSING_MERCHANT_ORDER`,
so a later duplicate on the same intent has its own incident and evidence.

The missing rule requires:

- A locally captured attempt, COMPLETED capture, matching integer amount/currency, and nonempty
  attempt, PayPal order and capture IDs.
- The newest persisted GET readback to confirm that same completed order and capture, single
  purchase unit, intent identity, capture ID and exact amount/currency.
- Zero effective placed merchant orders. Mismatched placed orders remain ambiguous/out of scope
  rather than generating this new incident class.
- Expiry of the grace period, at or beyond its exact deadline. Default: **300,000 ms (five minutes)**.
  This is a local implementation default, not an empirically measured merchant SLA.

Configure through the existing checker constructor:

```ts
const checker = new InvariantChecker(store, {
  missingOrderGraceMs: 300_000,
  now: () => fixedEpochMilliseconds, // omit in normal local usage to use Date.now()
});
checker.evaluateIntent(organizationId, intentId);
```

Grace starts at the first persisted confirmation timestamp in the newest uninterrupted run of
confirming readbacks. Rechecking or receiving more successful readbacks does not extend it.
A newer contradictory, empty, malformed, pending or refunded readback suppresses detection.
Persisted failed GET observations (`PAYPAL_API_RESPONSE` with `pre_capture_readback_error`,
`post_capture_readback_error`, `reconcile_readback_error`, `readback_error`, or
`webhook_readback_error`) also suppress it. A subsequent valid confirmation starts a new grace
interval. These error records are uncertainty metadata, never capture proof.
Invalid, future or decreasing confirmation timestamps fail closed. Grace must be a nonnegative
safe integer; zero explicitly disables waiting. Invalid clock/configuration records no evaluation.

## Evidence and inspection

Each evaluation, incident insertion and evidence linking occurs within one SQLite write transaction.
An incident links authoritative confirming readback rows. It does not borrow webhook trust or
controlled-fault causation. Cause is `UNKNOWN`. Zero-order observation is recorded in the immutable
opening evaluation, referenced by `reproduction.absenceObservation` and API `missingOrder.absenceEvidence`.
Its facts include grace configuration, confirmation/deadline/observation times, anchor readback,
confirming readback IDs, failed-readback IDs and observed order IDs.

Existing GET endpoints `/api/incidents`, `/api/incidents/:id`, and `/api/evaluations` expose the class
and evidence. Incident detail adds capture-value impact, the latest checked condition, explicit
guidance and `recoverySupported: false`. A late order results in a later HOLDS evaluation and
`ORDER_PRESENT` at the last check; the original incident stays open with its original evidence.
No financial loss, automated resolution or repair is inferred. Checks remain explicitly invoked;
the GET API never runs a check or repair.

Migration 7 widens the incident-class constraint through a transactional column swap while keeping
foreign keys enabled. It preserves existing class values and reinstates incident immutability before
commit. VERIFIED on a synthetic populated v6 database, including duplicate incident, evidence,
repair-plan and audit references; complete user-table row snapshots compare equal after migration,
foreign-key check is empty, and immutable guards still reject writes. Historical databases were
not opened or migrated during this work. Opening any old database through Store in future will
apply pending migrations; obtain separate approval before opening historical evidence databases.

## Exact verification

All final commands exited **0**. Tests used synthetic temporary SQLite databases only.

| Command | Passed | Failed | Skipped | Evidence |
| --- | ---: | ---: | ---: | --- |
| Baseline `pnpm test` | 430 (18 files) | 0 | 0 | `.work/runs/gate2b/baseline.log` |
| Final `pnpm exec vitest run tests/gate2b-missing-order.test.ts` | 50 (1 file) | 0 | 0 | `.work/runs/gate2b/focused-final.log` |
| Final `pnpm test` | 480 (19 files) | 0 | 0 | `.work/runs/gate2b/full-final.log` |
| `pnpm typecheck` | exit 0 | — | — | `.work/runs/gate2b/typecheck-final.log` |
| `pnpm build` | exit 0 | — | — | `.work/runs/gate2b/build-final.log` |

The 430 existing tests remain included and green. `build` is a new alias for the existing
`build:web` command; it is a Vite client build, with server TypeScript checked separately.
Node emits its existing experimental `node:sqlite` warning.

The 50 new cases cover completed/missing beyond grace; before/at/after expiry; future clock;
configurable/zero/invalid grace; repeated readbacks; pending/uncertain local attempts; missing
readback and identities; refunded/partially refunded/pending/denied captures; wrong order,
intent and amount; approved order; failed/empty/malformed/null readback structures; all five
persisted readback-error operations; interrupted grace; invalid/nonmonotonic timestamps;
healthy and late orders; immutable historical incident and refusal of duplicate repair;
cross-organization checker and API isolation, missing organization and HTTP-write refusal;
rollback after insertion; restart through independent connections; actual child process exit
before and after commit; three concurrent checker processes; separate missing/duplicate dedup;
and populated-v6 migration preservation.

Test-first evidence: initial run **16 failed / 17 passed** (33 cases) before implementation.
Independent review found the real failed-refresh evidence format was initially excluded;
five regressions failed before correction. Two later insufficient-identity regressions also
failed before correction. Final runs above include all corrections. An intermediate extended
test run had **1 failed / 42 passed** plus a cleanup failure because the synthetic v6 hydration
replayed the initial-state guard and left its fixture open. The fixture now restores the original
guards after synthetic hydration; the final populated-migration test passes. These intermediate
failures are retained in ignored local logs and are not counted as final passes.

Independent read-only review found and verified correction of the failed-refresh issue. Final
review also inspected the identity guards and report, independently reran **50/50** focused tests,
found no blockers, and approved the scoped diff for commit. The reviewer inspected the final
full-suite/typecheck/build logs without claiming to have independently rerun those commands.
Scoped heuristic secret scan found zero patterns in all nine changed files; staged scope and
whitespace checks are required before delivery.

## Reproduction

From `D:\Projects\OrderTruth` with the already installed dependencies:

```powershell
pnpm exec vitest run tests/gate2b-missing-order.test.ts
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

No `.env`, Sandbox access, buyer approval, external provider or historical database is required.
The synthetic child helper is invoked by the tests; its deliberate exit codes 77/78 simulate
interruption before/after commit, and are asserted as expected behavior.

## Limitations and unresolved risks

1. **VERIFIED scope / NOT TESTED live:** local persisted evidence only; no fresh Sandbox readback,
   webhook verification, AI, deployment, judge access or production certification was attempted.
   Detection may be stale until another readback/check is explicitly run. The five-minute grace
   and local wall clock need a real merchant SLA and clock discipline before broader use.
2. **VERIFIED API limitation:** organization headers remain development scoping, not authenticated
   RBAC. Keep this API local. The exposed condition is the latest recorded check, not a claim of
   continuous monitoring. An incident remains historical/open when an order arrives; lifecycle
   resolution and all missing-order recovery require separate authorization and design.
3. **VERIFIED conservative boundary:** contradictory/mismatched records and interrupted evidence
   suppress this class; this can delay detection but avoids inventing capture or merchant certainty.
   The contract covers the single-order reference merchant, not arbitrary merchant lifecycles.

COST / QUOTA: ₹0 incremental service spend; zero PayPal/AI API calls and no new dependencies.
Agent inference accounting is unavailable; no inference-cost or quota claim is made.
BLOCKING QUESTIONS: none. NEXT ACTION: reviewed, scoped Codex commit and normal push, then STOP.
No additional incident class, AI, merchant recovery, authentication or UI expansion is authorized.
