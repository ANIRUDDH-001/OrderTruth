# Gate 1A — capture-recovery design review (short)

**Date:** 2026-10-18 · **Author:** Claude Code (Opus 5.5) · **Scope:** Gate 1A only (D4 + additional requirements 1–8). No tunnel, no webhook, no Sandbox capture, no merchant module. **CLAUDE MADE NO GIT WRITES.**

## 1. Problems being fixed

| ID | Problem (Gate 0 code) | Root cause |
|---|---|---|
| F1 | DB write throws after PayPal capture 201 → attempt stuck `capture_in_progress`, HTTP 500, nothing reconciles | No reconciler; non-PayPal errors after the POST propagate as a generic 500 |
| F2 | Buyer retries after the 500 → `POST /api/orders` creates a new intent and order → a second, independent charge is possible | Intent is created per request; no checkout idempotency key |
| F3 | `checkout-service.ts:219` writes `state='approved'` unconditionally, so process B can reset A's `capture_in_progress` and win the claim | Unguarded state write; claim is CAS but the write before it is not |
| F4 | Evidence file written after the DB row; a file error throws | File treated as part of the critical path |
| F5 | Terminal short-circuit untested (masked by pre-capture readback) | Missing test |
| — | Immediate `APPROVED` readback after a capture timeout was treated as "safe to retry" (`state='approved'`) | Readback after an unknown-outcome write is not proof that the request cannot still complete |
| — | Missing `custom_id` in a readback was accepted | `custom_id !== undefined && …` check |

## 2. Design (smallest safe change)

1. **Guarded transitions, enforced twice.** `Store.transition(id, to, patch, from?)` is the only way to change `state`: a single `UPDATE … WHERE id=? AND state IN (<legal from-states>)`, returning whether it applied. `updateAttempt` rejects `state`. A DB trigger, seeded from a static `attempt_transitions` table, aborts any illegal transition from any process or code path (defence in depth). A test checks that the DB table equals the TypeScript `TRANSITIONS` map.
   - `capture_in_progress → approved` is **illegal**. A foreign process can no longer reset a claim (F3).
   - `uncertain → approved` and `created → uncertain` are removed. An unknown create outcome stays `created` with no order id and is retried with the same create request id.
2. **Durable checkout intent (F2).** The browser sends `x-checkout-key` (random, kept in `localStorage` until the checkout is terminal). `checkout_intents.checkout_key` is `UNIQUE`; the insert is `ON CONFLICT DO NOTHING`, so concurrent requests in different processes converge on one intent. One intent has exactly one attempt (`payment_attempts.intent_id UNIQUE`, unchanged), so request IDs stay stable. A repeat `POST /api/orders` with the same key:
   - no order id yet → re-issue create with the **same** `PayPal-Request-Id`; the order id is stored by CAS (`paypal_order_id IS NULL`);
   - `awaiting_buyer_approval` → returns the same order;
   - `approved | capture_in_progress | uncertain | pending` → `409 checkout_in_progress` (do not pay again);
   - `captured` → `409 checkout_already_paid`; `denied | mismatch` → `409 checkout_closed`.
3. **Post-capture local-write failure is not a 500 (F1).** The claim (`capture_in_progress`, `capture_posts+1`, `capture_claimed_at`) is committed **before** the POST. If any local write fails after the POST, the service makes a best-effort move to `uncertain` and returns `503 outcome_unknown` ("payment may have completed; do not pay again"). The claim row stays in the DB, so the money is never "forgotten".
4. **Evidence files are best-effort (F4, requirement 3).** The DB evidence row is authoritative. The file mirror is wrapped; a failure is logged as `evidence_file_write_failed` and never changes the payment outcome.
5. **Readback-only reconciler.** `CheckoutService.reconcile()` runs at server startup and on an interval. It selects `capture_in_progress` with a stale claim (`> reconcileStaleMs`), plus `uncertain` and `pending`. It issues **GET only** (asserted by tests) and applies the deterministic verdict through guarded transitions. If a stale claim shows no capture it moves to `uncertain`, **never** to `approved`, and never captures.
6. **Timeout ≠ proof (user D4 note).** After an unknown-outcome capture error (timeout, network, 5xx) or a stale claim, an `APPROVED` readback leaves the attempt `uncertain`. A capture retry is allowed only when **all** of these hold:
   - it is an explicit caller action (buyer/CLI capture), never the reconciler;
   - a fresh readback still shows `APPROVED` with no capture;
   - `captureSettleMs` (default `max(120 s, 4 × HTTP timeout)`) has elapsed since the last claim;
   - it reuses the **same** stored `PayPal-Request-Id`.

   Inside the window the caller gets `409 capture_outcome_pending`. The residual risk relies on PayPal's documented request-id idempotency and single-capture order semantics (NOT_TESTED live; retention window R4 unverified).
7. **Correlation evidence (requirement 2).** A readback without `custom_id` is now a `mismatch`. A pre-capture readback with any correlation mismatch (order id, `custom_id`, amount, currency) is **refused**: no capture POST, state `mismatch`. Justification: Gate 0 live readbacks returned `custom_id` (`.work/runs/gate0/…_0022/0024/0025`), so requiring it does not reject legitimate PayPal behaviour seen so far.
8. **Evidence labels (requirement 5).** 1A touches payment verification only. The reconciler writes only `PAYPAL_API_READBACK`, and no 1A code writes merchant/repair classes. Merchant-side repair verification arrives with D5 and will be labelled separately.

## 3. Explicitly not in 1A

Webhooks, tunnel, merchant module, fault-injection switch, abandoned-order expiry (G1-R07), Origin/CSRF (G1-S02), and any UI beyond the checkout-key header and safe error messages.

## 4. Tests written first (RED before GREEN)

| ID | Test | Real process? |
|---|---|---|
| A1 | Real SQLITE_BUSY: another connection holds the write lock during the capture → `503 outcome_unknown`, one POST, no `approved`; the reconciler then reaches `captured` with zero further POSTs | no (real SQLite lock) |
| A2 | Evidence-file write failure → still `captured`, one POST | no |
| A3 | Same checkout key twice → same order, one create POST; after capture → `409 checkout_already_paid`, no create POST | HTTP inject |
| A4 | Concurrent same-key creates → one intent, one order | no |
| A5 | Reconciler issues only GET (plus OAuth) across all target states | no |
| A6 | Timeout then immediate `APPROVED` → `uncertain`; retry inside the settle window refused with no POST; after the window one POST with the same request id | no |
| A7 | Terminal short-circuit: second capture makes **zero** PayPal calls (F5) | no |
| A8 | Missing `custom_id` → mismatch; pre-capture mismatch → no capture POST | no |
| A9 | DB trigger blocks `capture_in_progress → approved` even via raw SQL; DB transition table equals the TS map | no |
| P1 | **Two independent server processes** on one SQLite file; B's capture arrives while A's POST is in flight → exactly 1 capture POST (F3) | 2 OS processes + HTTP fake |
| P2 | **Real crash** (forced process kill) right after PayPal returns 201 → restarted process reconciles to `captured`, 0 extra POSTs | OS process kill |
| P3 | **Real crash** after the claim, before the POST → restart reconciles to `uncertain` (no POST); explicit retry after the window → 1 POST with the same request id | OS process kill |
