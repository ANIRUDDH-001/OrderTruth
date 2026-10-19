# Stage 1C — Repair contract review (design only, NOT IMPLEMENTED)

**Date:** 2026-10-19. **Status:** proposed for review. No repair code, endpoint, table or migration exists. Nothing here has been executed.
**Supersedes:** the sketch in `docs/STAGE1C_RESULTS.md` §7.
**Reviewed against:** the corrected checker (`src/merchant/contract.ts` `orderMismatches`/`matchingOrderIds`, `src/merchant/checker.ts` `attributeCause`, migration 5).
**Boundaries:** local reference-merchant data only. No PayPal call of any kind (no refund, void, capture or resend). No HTTP repair surface. ₹0.

## 1. Findings: what was wrong with the §7 sketch

| # | §7 said | Problem against the corrected checker / schema | Correction |
|---|---|---|---|
| R1 | "keep the earliest `placed` order, void the others" | Ignores order correctness. With an extra mismatched order (test K4: 2 matching + 1 mismatched → VIOLATED), the earliest order could be the mismatched one, and voiding would then leave a wrong record that HOLDS cannot accept. | Plan only when **every** placed order matches the capture (`matchingOrderIds` = all placed orders, ≥ 2). Any mismatched placed order → refuse (`REFUSED_MISMATCHED_ORDERS`); that is OUT_OF_SCOPE work, not this repair. The keeper is the earliest **matching** order by `(created_at, id)`. |
| R2 | "postcondition: HOLDS with exactly one active order" | HOLDS now means exactly one placed order **that matches** and **no** mismatched placed order. The postcondition must use the same pure `evaluateContract`, not a count. | Postcondition = `evaluateContract(post-state).result === "HOLDS"` **and** `matchingOrderIds` = `[keeper]`. |
| R3 | "moving the others `placed → voided_duplicate`" | Migration 4 makes `merchant_orders` immutable (`merchant_orders_no_update`). A status update would need that guard weakened. | Keep orders immutable. Add an append-only `merchant_order_voids` table (one row per voided order, FK to an executed repair); the contract treats an order as active iff it is `placed` and has no void row. Nothing is updated or deleted. |
| R4 | "a hash of the facts it relied on" (unspecified) | A partial hash allows a stale plan through, e.g. a new readback that removes eligibility (F4: REFUNDED), a new order, or a changed attempt. | The facts hash covers everything `evaluateContract` reads (§3.2). |
| R5 | "a real authenticated identity with a `repair:approve` role" | Correct as the production requirement, but it left the local demo undefined. The demo must neither imply authentication nor accept `x-ordertruth-org` as identity. | §3.3: a local CLI-only approval by a **declared** operator name, labelled `LOCAL_DEMO_DECLARED_OPERATOR`. There is no HTTP route. Exposure stays BLOCKED until real auth/RBAC exists. |
| R6 | "incident moves `open → resolved_verified`" | Incidents are immutable (`incidents_no_update`). | Append-only `incident_resolutions` row referencing the postcondition evaluation (trigger: that evaluation must be HOLDS for the same intent and later than the incident's opening evaluation). `incidents` stays immutable; the API derives the state. |
| R7 | (silent on cause) | After the provenance fix, cause can be `CONTROLLED_FAULT_INJECTION`, `MIXED` or `UNKNOWN`. A repair must not relabel it. | Repair is cause-agnostic and copies `reproduction.cause` into the plan for the audit trail only. A repair never rewrites the incident's reproduction or fault records. |
| R8 | "a failed postcondition rolls back" | A rollback erases the attempt record too, losing the audit trail. | Run the repair in transaction A. On postcondition failure roll back A, then record `FAILED_POSTCONDITION` in a separate append-only transaction B. |

## 2. Preconditions (planner refuses unless all hold)

1. The incident exists in the caller's org, is `DUPLICATE_MERCHANT_ORDER`, has no resolution row, and no other plan for it is `APPROVED` and unconsumed.
2. A **fresh** evaluation (appended now, in the planner's transaction) is `VIOLATED` for the incident's intent.
3. Every placed, non-voided order of the intent is in `matchingOrderIds` (R1), and there are at least 2.
4. The payment attempt is `captured` and eligibility holds. Eligibility already includes a confirming newest readback; the planner makes no PayPal call and never refreshes readbacks.

## 3. Lifecycle

### 3.1 Plan (read-only toward merchant data; appends plan + evaluation)

`repair_plans` (append-only, immutable):
`id`, `organization_id`, `incident_id`, `intent_id`, `contract`, `evaluation_seq` (the fresh VIOLATED one), `keep_order_id`, `void_order_ids_json` (sorted), `cause_at_plan` (copied, R7), `facts_json` (canonical), `facts_sha256`, `plan_sha256`, `created_at`, `expires_at` (proposed TTL: 15 min).

`plan_sha256` = sha256 of the canonical JSON of every column above except `plan_sha256` itself. The executor recomputes it from the stored row, so a row edited after approval fails.

### 3.2 Facts hash (R4)

Canonical JSON (sorted keys, no whitespace) of:
- contract id;
- intent `id, sku, currency, amount_minor, organization_id`;
- attempt `id, state, paypal_order_id, capture_id, capture_status, captured_minor, captured_currency`;
- the ordered list of PAYPAL_API_READBACK `seq` + sha256 of each `summary_json`;
- **every** merchant order of the intent (all columns) plus any void rows;
- the incident `id` and the absence of a resolution row.

Any new readback, order, void, attempt transition or resolution changes the hash.

### 3.3 Approval by a named local-demo operator (R5)

- **Surface:** a local CLI only, e.g. `pnpm repair approve --plan <id> --plan-sha256 <full hash> --operator "<name>"`. It requires an interactive TTY and a typed confirmation of the last 8 hex characters of the plan hash, after printing the plan: keeper, orders to void, facts, cause, expiry, and "no PayPal action". **No HTTP route** for plan, approval or execution exists in this stage. The read-only incident API may *display* plans and approvals.
- **Recorded:** `repair_approvals` (append-only): `id`, `plan_id` UNIQUE (one approval per plan), `plan_sha256`, `operator_name`, `identity_assurance = 'LOCAL_DEMO_DECLARED_OPERATOR'` (CHECK-constrained; no other value is possible in this stage), `approved_at`.
- **Honest label:** the operator name is *declared* by whoever runs the CLI as the OS user. It is not authenticated, and anyone with write access to the SQLite file can forge it. The UI and API must show `LOCAL_DEMO_DECLARED_OPERATOR` next to the name. Production needs real identity + `repair:approve`, with approver ≠ plan requester; that remains a **BLOCKER** for exposure.
- `x-ordertruth-org` is never read by the approval or execution code.

### 3.4 Execute: the executor checks everything itself

`pnpm repair execute --plan <id>` (CLI, local). The executor takes only the plan id and trusts no caller-supplied hash, name or flag. It opens one `BEGIN IMMEDIATE` transaction A and, in order:

1. **Idempotency:** if `repair_executions` already has a row for `plan_id` (UNIQUE), it returns that recorded outcome and changes nothing.
2. **Plan integrity:** it loads the plan row, recomputes `plan_sha256` and requires equality.
3. **Approval:** an approval row must exist for this `plan_id`, with `approval.plan_sha256 = plan.plan_sha256`, `identity_assurance = 'LOCAL_DEMO_DECLARED_OPERATOR'`, and must not have been consumed by another execution.
4. **Expiry:** `now < plan.expires_at`; otherwise `REJECTED_EXPIRED`.
5. **Staleness:** it recomputes the facts from the DB (§3.2) and requires `facts_sha256` equality, then re-runs `evaluateContract` and requires `VIOLATED` with `matchingOrderIds` equal to `{keep} ∪ voids`. Otherwise `REJECTED_STALE`; the approval is consumed and re-planning needs a new approval.
6. **Apply:** it inserts one `merchant_order_voids` row per void id. A trigger requires an `executing` repair_executions row for this plan that lists the order, the same intent and org, and that the order is not the keeper.
7. **Postcondition (R2):** it re-runs the checker logic in the same transaction and appends the evaluation (`run_id = repair execution id`). It requires `HOLDS` with `matchingOrderIds = [keep]`. It then asserts that the `payment_attempts` row and PayPal evidence rows are byte-identical to the pre-image, and that the fake/real PayPal client was never constructed.
8. **Resolve:** it appends `incident_resolutions(incident_id, evaluation_seq, execution_id)`; the trigger requires that evaluation to be HOLDS (R6). It marks the execution `SUCCEEDED`, then commits.

On any failure in steps 5–8, transaction A rolls back and transaction B appends `repair_executions(plan_id, outcome = REJECTED_STALE | REJECTED_EXPIRED | FAILED_POSTCONDITION, reasons)` (R8). Rejections from steps 2–4 are recorded the same way.

### 3.5 Proving postconditions (evidence produced)

- The appended HOLDS evaluation, which records `facts_json` with `matchingOrderIds = [keep]`.
- The `incident_resolutions` row linking incident → execution → evaluation.
- The before/after hashes of `payment_attempts` and `evidence` (unchanged), recorded in the execution row.
- Re-running the checker after commit gives HOLDS, and re-running execute returns the recorded outcome (idempotent).
- The demo shows: healthy copy untouched; fault copy VIOLATED → plan → approve → execute → HOLDS; source DB sha256 unchanged.

## 4. Tests required before any repair code is accepted (to write first, TDD)

| Id | Must prove |
|---|---|
| RP1 | plan → approve → execute on the fault scenario: HOLDS, 1 active order, resolution row, 0 PayPal calls, attempt/evidence byte-identical |
| RP2 | execute twice / concurrently → one effect, same recorded outcome |
| RP3 | no approval, approval of a different plan hash, consumed approval, edited plan row → refused, nothing voided |
| RP4 | stale: a new order, a new contradicting readback (REFUNDED), or an attempt change between approval and execute → `REJECTED_STALE`, nothing voided |
| RP5 | expired plan → `REJECTED_EXPIRED` |
| RP6 | 2 matching + 1 mismatched order → planner refuses (R1) |
| RP7 | forced postcondition failure → rollback, `FAILED_POSTCONDITION` recorded in transaction B |
| RP8 | cross-org plan/approve/execute → refused; the healthy intent is untouched |
| RP9 | the DB refuses a void row without an executing approved plan, a void of the keeper, and any update/delete of plans, approvals, voids or resolutions |
| RP10 | restart between approve and execute, and between A-rollback and B |
| RP11 | the incident `cause` and fault records are unchanged by repair (R7) |
| RP12 | no HTTP route accepts POST/PUT/PATCH/DELETE for repair (405), and `x-ordertruth-org` has no effect on approval |
| RP13 | mutation checks on each executor check in §3.4 |

## 5. Decisions needed from the user before implementation

1. Approve the append-only `merchant_order_voids` + `incident_resolutions` model (R3/R6), instead of relaxing the immutability triggers.
2. Accept the CLI-only, `LOCAL_DEMO_DECLARED_OPERATOR` approval for the local demo, with HTTP repair exposure BLOCKED until real auth/RBAC exists.
3. Plan TTL (proposed 15 min), and whether the demo must enforce approver ≠ requester even though both are declared names.

## Stage 1D accepted refinement (2026-10-19)

The product owner authorized implementation with append-only voids, resolutions and audit; CLI-only unauthenticated declared operators; a 15-minute TTL; and the same declared person permitted as requester and approver. Historical incident/order rows remain immutable. See `STAGE1D_IMPLEMENTATION_PLAN.md` and `STAGE1D_RESULTS.md` for implementation/evidence, which do not authorize the human demonstration.

This amendment supersedes the mutable execution state and transaction A/B wording in §3.4:
- `repair_executions` is immutable identity (`id`, unique `plan_id`, `started_at`). `repair_transitions` appends EXECUTING; `repair_outcomes` appends exactly one terminal outcome via its execution primary key. No execution row is updated.
- `BEGIN IMMEDIATE` holds the writer lock for validation, correction and result recording. A correction SAVEPOINT allows failed voids/postconditions to roll back while the outer transaction atomically commits the refusal/outcome/audit. This eliminates the rollback-to-transaction-B crash gap. A hard crash before outer COMMIT rolls back the whole invocation; retry revalidates the still-unconsumed approval. A crash after COMMIT returns the persisted terminal outcome on retry. No abandoned committed EXECUTING state is produced by the executor.
- The executor accepts only a plan ID. Its service is already bound to a local organization scope, which is not authentication. It validates integrity before dereferencing plan scope. Invalid plan references get an integrity refusal; its provider hashes cover the bound organization because the plan references are untrusted.
- Facts include the full attempt, every readback's full persisted row hash, every original order plus effective status and void rows, intent, incident, and resolution presence. This is stricter than §3.2's minimum. Plan hashes include distinct requester identity. A cause snapshot is audit-only and never establishes a new provenance claim.
- `status` remains the original order status; `effectiveStatus` is `voided_duplicate` only through a visible void record. The pure checker uses effective active orders. Incident `state` is derived from resolutions and `historicalState` preserves the opening state.
- Normal tests persist `approval_mode=SIMULATED_TEST` (test environment only); production CLI has no simulation option. Actual terminal testing uses an explicitly synthetic database and operator `AUTOMATED_SYNTHETIC_TTY_TEST_NOT_HUMAN`, recorded as `INTERACTIVE_TTY`. This proves terminal mechanics, not human authorization, authentication or separation of duties.
- A completed unapproved execution attempt consumes that plan with a durable refusal. New approval requires a new plan. A second plan after successful resolution is refused. Repeating an already terminal plan returns its same outcome.
