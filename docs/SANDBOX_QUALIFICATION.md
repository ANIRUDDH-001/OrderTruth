# Genuine Sandbox qualification procedure

This is a prepared procedure, not a record of completed integration. Financial operations remain Sandbox only; production PayPal hosts fail closed. The original October observation and existing receipts are preserved.

## Scope requiring owner authorization

1. Register at most one webhook on the existing Sandbox app for `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED` and `CHECKOUT.ORDER.APPROVED`, pointing to the existing HTTPS backend `/api/paypal/webhook`. Save its ID privately, update the existing backend's private webhook configuration and redeploy through the qualified release procedure. Delete only that newly created registration if rollback is necessary; never remove an existing registration.
2. Create at most one server-priced USD1.00 Sandbox reference order, with the owner manually approving it using a Sandbox personal buyer account. Submit at most one capture POST. The hosted server's original idempotency/claim rules remain authoritative; after uncertainty, stop capture and use readback.
3. Allow at most five qualification-triggered order GET readbacks and five webhook-signature verification calls, plus necessary Sandbox OAuth. Provider retries can generate additional incoming webhook deliveries; intake remains bounded and authenticated. Do not weaken signature verification to force completion.
4. No live payment, refund, real card, additional paid service or existing-data deletion.

## Execution and proof

Verify exact frontend/backend source, schema9, NORMAL/readiness, owner session and Sandbox-only configuration first. Privately compare the backend app identity with the app used for registration; stop on mismatch. Recheck existing registrations before creating one, and read back any uncertain registration result before retrying.

Open protected checkout through the owner's account menu. Buyer approval is a user handoff. Keep the active order and checkout key through refresh. Count provider requests; do not repeat order creation/capture after an uncertain response. Reconcile using the saved order and authoritative GET. Show a verified capture only when completed capture identity, USD1.00 and stored evidence agree.

For genuine webhook delivery, separately prove original raw bytes persisted, PayPal signature result accepted, event correlation, durable inbox processing and event-ID deduplication. Capture redacted status/count/hash evidence rather than tokens, raw private bodies or account data. Incoming retries are distinct from a fabricated replay. Duplicate/reordered/crash fault tests performed locally stay labelled synthetic unless actual genuine delivery is independently observed.

Create one isolated controlled merchant discrepancy from the new persisted observation, detect, inspect deterministic evidence, optionally use separately authorized AI, approve the exact merchant-only plan, correct, then independently read its receipt and database postconditions. Reopen after reload/restart. Compare stored provider hashes; this comparison does not substitute for a fresh PayPal readback.

Stop the affected provider operation on inconsistent readback, unknown outcome, nonzero unexpected cost, exhausted budget, app mismatch or signature failure. Continue independent local work. Record actual calls and any incomplete checks in the single execution ledger.
