# Stage 1C — Merchant contract, controlled fault and first incident

**Date:** 2026-10-19. **Status:** independent review of `a36852d` accepted this as an offline detection prototype, with corrections (§9). **Gate 1 is NOT complete:** the human-approved repair workflow is designed (`docs/STAGE1C_REPAIR_CONTRACT.md`) but not implemented or executed. Gate 2 has not started.
**Budget:** ₹0. No new dependency. **Zero PayPal calls in Stage 1C**: no checkout, capture, refund, resend or tunnel.
**Git:** Claude made no commits. The user committed the original Stage 1C work on `main` as `8901a53`, `9e16564`, `248b804`, `2f10308` and `a36852d`; the `docs/GATE1B_LIVE_RESULTS.md` deletion evidence is in `130a001`. The review corrections in §9 are **uncommitted** working-tree changes on top of `a36852d` and await an authorized Git actor.

Claim labels: **VERIFIED** (reproduced in this stage, with the log path given), **RECORDED_NOT_REPRODUCED**, **HYPOTHESIS**, **BLOCKED**, **NOT_TESTED**.

## 1. What was shown

A valid, already captured PayPal Sandbox payment can coexist with incorrect local merchant state, and OrderTruth detects this deterministically from evidence:

- **Payment:** Gate 1B order `7TS74882M0297892Y`, capture `79N705976G542051J` (COMPLETED, USD 1.00). It was captured live on 2026-10-19 and is not re-executed here.
- **Merchant state:** in an isolated copy of the real database, a labelled CONTROLLED_FAULT_INJECTION makes the reference merchant place **two** local orders for that single capture.
- **Incident:** an incident opens only because the merchant records contradict the authoritative payment evidence. It is linked to the real PayPal readback rows and the real verified webhook events.

## 2. Design

| Piece | File | Notes |
|---|---|---|
| Schema (migration 4, additive) | `src/db/store.ts` | Tables: `organizations` (seeded `org_reference`), `checkout_intents.organization_id` (immutable, NOT NULL DEFAULT `org_reference`), `fault_injections`, `merchant_orders`, `invariant_evaluations`, `incidents`, `incident_evidence`. Every new table is append-only or immutable through triggers; nothing is ever deleted. |
| Contract | `src/merchant/contract.ts` | `REF_MERCHANT_ONE_CAPTURE_ONE_ORDER_V1`: one captured, eligible checkout intent yields exactly one `placed` merchant order **that matches the capture**: attempt, PayPal order id, capture id, SKU, currency and amount (`orderMismatches`). A pure function with no I/O. |
| Reference merchant | `src/merchant/reference-merchant.ts` | Two paths (`capture_return`, `webhook_capture_completed`). **REF-BUG-1** (deliberate): check, then `await`, then insert, with no unique key on `intent_id`. It never calls PayPal. |
| Fault injector | `src/merchant/fault-injection.ts` | Records a `fault_injections` row (label CHECK = `CONTROLLED_FAULT_INJECTION`) **before** running. A 2-party barrier then pins the interleaving, and both orders carry the fault id. It refuses an uncaptured intent, an intent in another org, or an intent that already has orders. |
| Invariant checker | `src/merchant/checker.ts` | Runs one transaction per intent. It always appends an evaluation. It opens an incident only on VIOLATED, idempotent via `dedup_key` UNIQUE + `ON CONFLICT DO NOTHING`. It links evidence idempotently and makes zero PayPal calls. |
| Read-only API | `src/merchant/api.ts`, `api-main.ts` | Routes: `GET /api/incidents`, `GET /api/incidents/:id`, `GET /api/evaluations?intentId=`. Every other method returns 405. Bound to 127.0.0.1:3003 and refuses the live DB. Org scope comes from the dev-only `x-ordertruth-org` header. |
| Demo | `src/merchant/demo.ts` (`pnpm stage1c`) | Byte-copies the source DB (refusing if a `-wal` file is present), checks the copy hash equals the source, migrates **the copy only**, and re-checks the source hash afterwards. Refuses to overwrite existing outputs. |
| Stale-readback fix | `src/webhooks/processor.ts` | A capture event whose successful GET shows **no capture at all** becomes `retryable_failure` (`CAPTURE_NOT_YET_VISIBLE`), bounded by `maxAttempts`, and then becomes `failed` ("gave up") instead of `disagreed`. A readback showing a different capture, amount, currency or custom_id stays a terminal `disagreed`. |

**Eligibility rule** (all conditions must hold before duplicates are judged):
- The attempt is `captured`.
- The local capture status is COMPLETED.
- The captured amount equals the intent amount.
- The newest HTTP-200 PAYPAL_API_READBACK that shows any capture confirms all of: the same order id, one purchase unit, custom_id equal to the intent, exactly one capture with the same id, status COMPLETED, and the same amount.

Results:

| Situation | Result |
|---|---|
| Not eligible, 0 orders | NOT_ELIGIBLE |
| Not eligible, ≥1 order | OUT_OF_SCOPE (no incident) |
| Eligible, exactly 1 placed order, and it matches | HOLDS |
| Eligible, 0 orders | OUT_OF_SCOPE (missing-order is not an incident class in Stage 1C) |
| Eligible, ≥2 **matching** orders (any extra mismatched order is listed in the reasons) | VIOLATED → incident `DUPLICATE_MERCHANT_ORDER`, severity high |
| Eligible, any mismatched placed order and fewer than 2 matching | OUT_OF_SCOPE; each order's differing fields are given as reasons (no second incident class) |

**Evidence labels.** The database enforces both a CHECK and a BEFORE INSERT trigger. Each link must reference an existing record of its own kind for the incident's own intent, attempt and org.

| Label | References | Requirement |
|---|---|---|
| `PAYPAL_API_READBACK` | `evidence.seq` | class `PAYPAL_API_READBACK`, HTTP 200, same attempt |
| `PAYPAL_VERIFIED_WEBHOOK` | `webhook_events.event_id` | `processed`, first delivery `verified`, same attempt |
| `MERCHANT_DB_OBSERVED` | `merchant_orders.id` | same intent and org |
| `CONTROLLED_FAULT_INJECTION` | `fault_injections.id` | same intent and org |

Causal provenance (corrected, §9) comes only from the **involved** (matching) orders' own `fault_injection_id`:
- every involved order references a recorded fault → `CONTROLLED_FAULT_INJECTION`;
- none does → `UNKNOWN`;
- some do → `MIXED`.

A fault record that no involved order references (for example, an injection that failed) is kept in `reproduction.unreferencedFaultRecords` with `causalStatus: NOT_REFERENCED_BY_ANY_INVOLVED_ORDER`. It is not linked as incident evidence (tests C7, V0–V3).

## 3. Healthy vs faulty comparison on the real data (VERIFIED)

The source is `.work/ordertruth.sqlite` (schema v3; 10 intents, 2 of them captured). It was byte-copied twice: no `-wal` file existed, and each copy's sha256 equals the source's. Command:
`pnpm stage1c --mode both --target-order 7TS74882M0297892Y`. Logs are in `.work/runs/stage1c/04-demo.txt`, `demo-healthy.json` and `demo-fault.json`.

| | Healthy copy | Fault copy |
|---|---|---|
| Gate 0 intent `ci_30e04c67…` (order `7PR849237P132474B`) | both paths → **1** order → HOLDS (readback 24, 25) | both paths → **1** order → HOLDS (readback 24, 25) |
| Gate 1B intent `ci_b18b1fa3…` (order `7TS74882M0297892Y`) | both paths → **1** order → HOLDS (readback 29, 31, 33, 34) | CONTROLLED_FAULT_INJECTION → **2** orders → **VIOLATED** |
| 8 uncaptured intents | NOT_ELIGIBLE, 0 orders | NOT_ELIGIBLE, 0 orders |
| Incidents | **0** | **1** |
| Source sha256 before/after | `390fe8d8…16b1bb` unchanged | unchanged |

**The incident** (fault copy, run 2): `inc_b2101aad-48e6-4e0d-b5ac-f0f0884ee86a`, `DUPLICATE_MERCHANT_ORDER`, severity high, state open, opened 2026-10-19T03:22:16.472Z, titled "2 merchant orders for one captured PayPal payment". Evidence:

| Label | Ref | Source time |
|---|---|---|
| PAYPAL_API_READBACK | evidence 29, 31, 33, 34 (real Gate 1B readbacks; pre-capture seq 27 correctly excluded) | 02:52:21Z – 02:54:33Z |
| PAYPAL_VERIFIED_WEBHOOK | `WH-1NG46012R3628551T-67U93725A3753941E` (CHECKOUT.ORDER.APPROVED), `WH-2W029761NA509782X-1TN43801VW6819635` (PAYMENT.CAPTURE.COMPLETED), both real verified deliveries | 02:52:22Z, 02:52:25Z |
| MERCHANT_DB_OBSERVED | 2 orders (`capture_return`, `webhook_capture_completed`), provenance CONTROLLED_FAULT_INJECTION | 03:22:16Z |
| CONTROLLED_FAULT_INJECTION | `fi_0ea21014…` (DUPLICATE_ORDER_RACE, REF-BUG-1) | 03:22:16Z |

**Repeatability:** two separate demo runs produced identical normalized outcomes (orders, results, reasons, evidence refs). Only generated ids and timestamps differ.

**Bounded API run** against the fault copy on 127.0.0.1:3003 (`.work/runs/stage1c/06-api-probe.txt`):

| Request | Status |
|---|---|
| list | 200 |
| detail | 200 |
| no org header | 401 `organization_required` |
| other existing org | **404** (indistinguishable from missing) |
| POST | 405 |
| DELETE | 405 |
| malformed id | 400 |

The `nosniff`, `no-referrer` and `no-store` headers are present. The process was stopped and the port confirmed closed.

## 4. Tests (VERIFIED, offline, PayPal MOCKED)

- `pnpm typecheck`: exit 0.
- `pnpm test`: **15 files, 310/310** (284 baseline + 26 new). No existing test was changed; `tests/fake-paypal.ts` gained only `staleCaptureGets`.
- `pnpm build:web`: exit 0.
- Logs: `.work/runs/stage1c/07-…10-*.txt`.

`tests/stage1c-merchant-incident.test.ts` (19 tests):

| Area | Tests |
|---|---|
| Fault vs healthy | C1 healthy (1 order, HOLDS, 0 incidents); C2 fault (2 labelled orders, VIOLATED, 1 incident with all four labels) |
| Repeatability | C3: 5 fault + 5 healthy runs identical |
| Idempotent rechecks | C4: no second incident, no duplicate evidence, every run recorded |
| Restart persistence | C5: close/reopen, API output identical, fresh checker opens nothing |
| Checker purity | C6: zero PayPal calls, no state change |
| Organic race | C7: unlabelled race detected, cause UNKNOWN |
| False positives | F1 uncaptured; F2 captured with 0 orders; F3 local "captured" with no confirming readback; F4 newer contradicting readback; F5 failed/pre-capture readbacks never confirm, and only the faulty intent among several is accused |
| Evidence integrity | E1 every link resolves; E2 mislabelled/cross-intent links, rewrites and deletes refused by the DB; E3 no incident without a VIOLATED evaluation |
| API | A1 detail fields; A2 cross-org list empty and detail 404; A3 another org cannot place orders, inject or evaluate |
| Migration | M1 v3 → v4 preserves every existing row and value |

`tests/stage1c-stale-readback.test.ts` (7 tests):

| Test | What it proves |
|---|---|
| R1 | stale GET → `retryable_failure`, attempt untouched; next GET → `processed`/`captured`, with **zero extra capture POSTs** |
| R2 | capture never visible → `failed` (gave up), never `disagreed`, attempt never captured |
| R3 ×3 | different capture id, amount or currency → still `disagreed` |
| R4 | forged custom_id → `disagreed` before any readback |
| R5 | the pure rule |

**Mutation checks** (`.work/runs/stage1c/03-mutation.json`). All sources were restored byte-identical (sha256 verified).

| Mutation | Killed by |
|---|---|
| M1 drop the `CAPTURE_NOT_YET_VISIBLE` rule | R1, R2, R5 |
| M2 treat it as terminal | R1, R2 |
| M3b remove the merchant's await window | C2, C3, C4, C5, C7, F5, E1, E2, A1, A2 |
| M4 remove incident dedup | C4, C5 |
| M5 disable the evidence-reference trigger | E2 |
| M6 ignore a contradicting readback | F4 |
| M7 drop org scope from incident detail | A2 |
| **M3 remove the barrier** | **survived** |

Explanation for M3: the merchant's own `await` between check and insert already lets both concurrent paths pass the check. The barrier only pins the interleaving against future scheduling changes, so it is not load-bearing today. C7 now covers the organic race.

## 5. Migration and rollback safety

| Item | Status | Detail |
|---|---|---|
| Additive migration | VERIFIED | Migration 4 only creates tables, triggers and indexes, and adds one column with a constant default. Existing rows and values are unchanged (test M1; `integrity_check` = ok on both demo copies). |
| v3-shaped inserts | VERIFIED | Intent inserts that omit `organization_id` still work on v4 (the existing checkout code path is used by the whole suite). |
| Live DB not migrated | VERIFIED | `.work/ordertruth.sqlite` is still schema v3; sha256 `390fe8d8c12a8b787480158420355f940fc7aeb4e25ae0954cafcc461b16b1bb` before and after. Only copies were opened. |
| Rollback point | VERIFIED | `.work/backups/ordertruth.pre-stage1c-v3.20261019T032345Z.sqlite`, byte-identical to the live v3 DB (same sha256). The earlier Gate 1B `VACUUM INTO` backup is also untouched. |
| **Warning: auto-migration** | — | `Store` migrates on open. The next `pnpm start` or `pnpm webhooks` against the live DB will apply migration 4 automatically. Take a fresh snapshot first (`VACUUM INTO` or a byte copy with no `-wal` present). |
| Rollback procedure | — | Stop all processes, then restore the v3 copy. A v4 demo copy is disposable: just delete it. |
| Code downgrade on a v4 DB | HYPOTHESIS / NOT_TESTED | Older code would ignore the new tables, and `org_reference` exists for the column default. |

## 6. Limitations and security blockers

| Item | Status | Detail |
|---|---|---|
| `x-ordertruth-org` is **not authentication** | BLOCKER for any exposure | Any local caller can name any existing org. Real identity and RBAC are required before anything leaves 127.0.0.1. |
| Merchant not wired into the live flows | — | The reference merchant is invoked by tests and the demo, not by the live capture-return or webhook handlers. Running it live is NOT_TESTED. |
| Single incident class | by design | Only `DUPLICATE_MERCHANT_ORDER`. Missing orders, wrong amounts and orders without a capture are recorded as OUT_OF_SCOPE evaluations, not incidents. |
| Incidents and orders are immutable | by design | No resolve, void or repair transitions exist yet. |
| Checker is on-demand | — | No scheduler. An incident reflects state at evaluation time; a later refund readback would only change the *latest* evaluation, and the open incident remains. |
| Byte-copy demo relies on the absence of a `-wal` file | — | It refuses otherwise; this does not replace a `VACUUM INTO` snapshot of a running DB. |
| Stale-readback fix not exercised live | RECORDED_NOT_REPRODUCED / NOT_TESTED live | Offline proof only. Real PayPal GET staleness timing is unknown. |
| Remaining Gate 1B risks | — | Inbox ceiling check-then-insert; transmission_time reuse HYPOTHESIS; cert host/auth-algo not logged; Windows shutdown needs `/F`; WAL backup discipline; only first-delivery proven live. |
| `.env` | — | Untouched. `PAYPAL_WEBHOOK_ID` still names the deleted registration; the owner must update it locally before any future live webhook work. |

## 7. Proposed next-stage contract: operator-approved, local-only repair (NOT IMPLEMENTED)

> **Superseded** by `docs/STAGE1C_REPAIR_CONTRACT.md`. That document reviews this sketch against the corrected checker (findings R1–R8) and specifies approval, independent executor checks, stale-plan rejection and postcondition proof. The sketch is kept below for history.

1. **Scope:** only `DUPLICATE_MERCHANT_ORDER` incidents in `open` state, and only on the local reference merchant. No PayPal write of any kind (no refund, void or capture). The payment is correct; the merchant record is not.
2. **Plan (dry run):** recompute the contract. If it no longer reports VIOLATED, refuse. Otherwise propose keeping the earliest effective `placed` order and appending void records for the others. Original merchant-order rows and their `placed` status remain immutable; effective `voided_duplicate` status derives from those void records. Store the plan with a hash of the facts it relied on.
3. **Approval:** a named operator approves that specific plan hash. Approval expires and is single-use. Requires a real authenticated identity with a `repair:approve` role, so the dev header is insufficient (blocker in §6).
4. **Execute:** one transaction with an idempotency key equal to the plan id. Re-check that the facts hash is unchanged (if it changed, abort and re-plan), then append only the approved merchant void records. No original order update or delete.
5. **Postcondition:** re-evaluate in the same transaction. The plan commits only if the result is HOLDS with exactly one active order. Append an incident resolution linked to the evaluation; effective `resolved_verified` state derives from that record, while the original incident remains immutable.
6. **Audit:** append-only repair log (who, when, plan, before/after, evaluation seq), visible in the incident API.
7. **Tests:** double execution is idempotent; a stale plan is refused; an unapproved, expired or cross-org plan is refused; a failed postcondition rolls back; a healthy intent is untouched; restart mid-flow; mutation checks.

## 8. Reproduce

```bash
pnpm typecheck
pnpm exec vitest run tests/stage1c-merchant-incident.test.ts tests/stage1c-stale-readback.test.ts
pnpm stage1c --mode both --target-order 7TS74882M0297892Y   # needs fresh --out-dir if .work/stage1c/*.sqlite exist
pnpm incidents --db .work/stage1c/fault.sqlite                # 127.0.0.1:3003, header x-ordertruth-org: org_reference
```

## 9. Review corrections (review of `a36852d`, 2026-10-19) — uncommitted

**P1a — the contract checks order correctness, not just the count.** Before the fix, `evaluateContract` only counted `placed` orders. A single order with the wrong capture id, amount, currency, PayPal order id or SKU therefore gave `HOLDS`.
- **Contract:** `orderMismatches(order, payment)` lists every differing field: attempt, PayPal order id, capture id, SKU, currency and amount minor. `Evaluation` gained `matchingOrderIds`. Results follow the table in §2.
- **Checker:** passes every order field plus the intent SKU, records `matchingOrderIds` in `facts_json`, and titles the incident with the matching-order count.
- **DB (migration 5):** the `merchant_orders_i` trigger now also requires that the attempt is `captured` and that the order's PayPal order id, capture id, SKU, currency and amount equal the attempt/intent values. There is deliberately still **no unique key on `intent_id`**, so REF-BUG-1 stays reproducible (K9, C2). Rows written before migration 5 are not rewritten, but the checker compares them anyway (K6, K10).

**P1b — causal provenance.** Before the fix, any fault record for the intent made the cause `CONTROLLED_FAULT_INJECTION`. Now `attributeCause` uses only the involved orders' fault references (§2). Test V1 reproduces the reviewer's case: a fault record is written before execution, the injection fails, and an organic duplicate follows. The result is `UNKNOWN`. The fault row is preserved but not linked as evidence.

**P2 — repair.** Reviewed and specified in `docs/STAGE1C_REPAIR_CONTRACT.md`; not implemented. No repair endpoint exists, and `x-ordertruth-org` is still not authentication.

**Verification (VERIFIED; logs in `.work/runs/stage1c-corrections/`, ignored):**

| Check | Result |
|---|---|
| New tests fail before the fix (`01-red.txt`) | 19 of the first 22 failed for the stated reasons: `HOLDS` for a wrong-capture order, and `CONTROLLED_FAULT_INJECTION` for the failed-injection duplicate. The 3 that passed are controls (K0, K5, K9). K8b, V0 and K10 were added after the fix: K8b and V0 kill mutation survivors, and K10 covers the v4 → v5 migration. None of them can pass on `a36852d`: the v4 trigger accepts the K8b row, `attributeCause` did not exist, and there was no v5. |
| `pnpm typecheck` | exit 0 (`08-typecheck-final.txt`) |
| `pnpm test` | **16 files, 335/335** (310 baseline + 25 in `tests/stage1c-corrections.test.ts`) (`09-test-final.txt`) |
| `pnpm build:web` | exit 0 (`10-build-final.txt`) |
| Existing tests changed | M1 only: the hard-coded schema version `4` became `MIGRATIONS.length` (now 5), because migration 5 is new. Its assertions on preserved rows are unchanged. |
| Demo on byte copies (`05-demo.txt`, `.work/stage1c-v5/`) | Healthy: 2 HOLDS, 0 incidents. Fault: 1 HOLDS + 1 VIOLATED → 1 incident with cause `CONTROLLED_FAULT_INJECTION` (both orders reference the fault), linked to 4 readbacks, 2 webhooks, 2 orders and 1 fault. Cross-org request returns 404. Copies are at schema v5. |
| Live DB | `.work/ordertruth.sqlite` is still v3: sha256 `390fe8d8…16b1bb` unchanged, no `-wal`. **The next `Store` open will apply migrations 4 and 5.** |
| Mutations (`06-mutations.txt`, `07-mutations-after-strengthening.txt`) | 16 mutations applied to the new logic. First pass: 13 killed and **3 survived**: N8 (a mismatch is ignored when one order matches), N12 (a dangling fault reference is trusted) and N15 (the trigger drops the `captured` state check). Tests were strengthened (K3 reason assertions, V0, K8b); all 3 are now killed, **16/16**. N12 cannot occur through the DB, because the FK and trigger reject dangling fault ids, so V0 tests the pure function directly. |
| PayPal / cost | Zero PayPal calls, no tunnel, ₹0 |
