# Isolated G2 Sandbox bootstrap — offline live-readiness GO; execution not authorized

**Acceptance (RECORDED_NOT_REPRODUCED):** owner reports Claude independently accepted G2 offline live-readiness GO at source `802f758dab677c864ed022609b800e8c82e06ab7c07efe1de20910f00fff2702`. Genuine Sandbox remains **NOT_TESTED** for this isolated G2 path; historical G0/G1 provider proof does not qualify it. Acceptance does not authorize execution.

The executable is `scripts/lab-reference-sandbox.ts`. It never starts on import. No live invocation was performed during implementation. It connects the reference runtime, authenticated inbox/processor and the existing single-route ingress without modifying hosted V2. It requires an existing owner-approved Sandbox webhook registration; registration creation/deletion is deliberately not an executable runner action.

## Approval and local prerequisites

The owner must first approve the exact reviewed source and provider-call scope. A JSON file asserting approval is an operator record, not cryptographic evidence of an owner's identity. Do not generate an approved artifact on the owner's behalf or run merely because a template can be filled.

The safe source-identity command performs no credential/environment loading or provider request:

```text
pnpm exec tsx scripts/lab-reference-sandbox.ts --source-identity
```

The owner-selected approval JSON must be below project `.work/`, at most 16KB, with exactly these fields:

```json
{
  "version": 1,
  "authorization": "OWNER_APPROVED_G2_SANDBOX",
  "runId": "0123456789abcdef",
  "approvedSourceSha256": "<the reviewed 64-character source digest>",
  "approvedAt": "<owner-approved UTC ISO timestamp>",
  "expiresAt": "<UTC ISO timestamp, no more than 24 hours later>",
  "merchantId": "<actual reference merchant identity>",
  "payeeMerchantId": "<expected Sandbox merchant_id>",
  "webhookId": "<existing approved registered webhook ID>",
  "tunnelWebhookUrl": "https://<approved-free-tunnel-host>/webhooks/paypal",
  "port": 3008,
  "approvedActions": ["initialize", "listen", "create-order", "capture-approved-order", "invoke-return", "replay-webhook"],
  "amountMinor": 100,
  "currency": "USD",
  "maximumSpendINR": 0,
  "registrationMode": "reuse",
  "recordedPayeePreflight": {
    "path": ".work/<reviewed-recorded-preflight>.json",
    "sha256": "<exact reviewed 64-character artifact digest>"
  }
}
```

The recorded preflight is an explicit mock/recorded shape check, performed before any order creation; it does not authenticate a real merchant account. Its JSON contains `provenance: "OFFLINE_RECORDED_MOCK"` and a `readback` with exactly one purchase unit whose `payee.merchant_id` matches the approved merchant. Email-only or mismatching payee data fails closed. This file cannot satisfy the genuine-path pre-approval gate. After order creation, a counted trusted-client GET must match the created order ID and approved payee before either buyer URL release or capture is possible. A separate fresh GET checks the actual order again immediately before the one capture attempt.

The owner stores these values only in the project's gitignored `.env`, never in approval JSON, logs, screenshots, chat or review bundles:

- `PAYPAL_ENV=sandbox` and `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`.
- `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` for the approved Sandbox application.
- `LAB_PG_ADMIN_URL`: explicit credentialed `postgresql://...@127.0.0.1:<local-port>/postgres` (or localhost), no URL options, never a hosted service.
- `LAB_CAPABILITY_KEY_CROSS_PATH` and `LAB_CAPABILITY_KEY_CORRECTED`: distinct 32-byte random keys encoded as 64 lowercase hex characters.

The runner accepts no custom provider, API host, fetch, model, test authority or hosted database configuration. The keys do not enter the browser. Local filesystem/OS account access remains trusted; this is not hardened against a compromised host.

## Initialize and run

Only after explicit owner authorization:

```text
pnpm exec tsx scripts/lab-reference-sandbox.ts --action initialize --approval .work/<approval>.json --execute
pnpm exec tsx scripts/lab-reference-sandbox.ts --action session --approval .work/<approval>.json --execute
```

`initialize` makes **zero PayPal requests**. It creates only `.work/lab-reference/<runId>/`, its proof SQLite store, and two new local PostgreSQL databases named `otg_<runId>000a` / `otg_<runId>000b`. Existing directory/database/schema ownership is refused; no historical data is overwritten or automatically deleted. Partial initialization remains visible for owner inspection; the runner does not silently drop databases to retry.

`session` retains one constrained native client/token across local commands and a durable `provider-budget.jsonl`, avoiding a new OAuth request for every command. It verifies the approved registration's URL and event types once and stores a sanitized registration receipt. Restarts under the same source/config reuse that receipt rather than exceed the one-registration-GET cap; this cached receipt is not a fresh registration readback. A session lock prevents concurrent bootstrap sessions; a stale lock after a hard process death requires owner inspection before any manual removal. Store data, keys and budget counts are not reset on restart.

The public tunnel must expose only this loopback listener's `POST /webhooks/paypal`. There is no public create/capture/refund/debug/admin route. Capture and local merchant invocations happen only through the owner's local stdin commands:

| Local command | Meaning |
|---|---|
| `create-order` | Reserve budget capacity and claim the single USD1.00 purchase; create it, GET and verify its exact order ID/payee, register its actual server-owned intent/order in both isolated Lab stores, then flush the matching success receipt before releasing the Sandbox approval URL. A preexisting attempt refuses a second purchase. |
| `capture-approved-order BUYER_APPROVED` | After manual buyer approval, require the matching durable pre-approval receipt, perform the existing fresh order/payee readback, then use the guarded capture flow at most once. A prior capture claim refuses retries. |
| `invoke-return cross-path` | Invoke the return handler for the single local intent; receipt says `LOCAL_BOOTSTRAP_INVOCATION`. This is **not** an actual browser return route. |
| `invoke-return corrected` | Invoke the corrected return writer for the same already-captured purchase in the separate store. |
| `events` | List persisted event IDs/types/states without new provider calls. |
| `replay-webhook corrected WH-...` | Replay already verified event evidence into the corrected store, with local-bootstrap/replay provenance. This is not another genuine PayPal delivery. |
| `budget` | Show durable operation counts and sanitized request metadata. |
| `stop` | Close the listener/stores/pools and release the session lock. |

### Pre-approval receipt and failure behavior

The sequence is budget guard → durable create claim → create POST → counted trusted-client order GET → exact order/payee validation → both intent registrations → flushed exclusive-write `pre-approval-payee-readback.json` → approval URL release. The receipt records `PAYPAL_ORDER_READBACK_PRE_APPROVAL`, source/run/order/intent/payee bindings, response digest and sanitized read metadata. It is a local durable record of provider readback, not buyer approval or capture evidence.

Capture requires the receipt to match the current source, run, order, intent and approved payee before the existing fresh pre-capture readback and capture guard. Missing/mismatched identity, GET failure, quota exhaustion, registration or receipt-write failure releases no URL. An uncertain create or failed preflight retains its claim and consumed budget across restart: no second create, claim reset or automatic financial retry. Missing/mismatched receipt blocks capture. `BUYER_APPROVED` is a manual operator assertion after Sandbox buyer approval, not automated login or provider capture evidence.

The extra GET fits within unchanged orderGET12/total23 caps. Availability of the real pre-approval `payee.merchant_id` remains **NOT_TESTED**; missing/email-only data halts the run without an inferred fallback. The recorded mock shape check, pre-approval provider readback and pre-capture provider readback are three separate checks.

Genuine capture webhook delivery invokes the cross-path runtime automatically through the authenticated workflow. Delivery may precede the local return invocation; cross-path duplication is sequentially reproducible in either order. Operator receipts must report the actual ordering. No manual duplicate injection is used. The corrected result uses the same captured evidence, not a second payment.

## Limits and stop conditions

The constrained client mechanically reserves every request before fetch, including OAuth; failed requests still consume their slot. Reuse policy caps are OAuth3, create1, capture1, orderGET12, verification5, registrationGET1, total23. Registration create/delete are prohibited in this runner. No refund/void/payout/subscription or additional-purchase method is exposed.

Stop on budget exhaustion, expired/mismatched source approval, invalid payee/capture/readback, signature failure/unavailability, unexpected provider mutation, unclear registration ownership or actual cost. An uncertain capture is not failed: use readback and owner review, never automatic capture retry. The runner closes on `stop`, EOF or SIGINT/SIGTERM; SIGKILL cannot run cleanup, so durable data and the stale lock are preserved for inspection. Tunnel lifecycle and any external registration cleanup remain separately authorized owner work.

## Verification limits

Focused offline tests cover strict approval/config parsing, source binding, invalid action and execution guards, recorded-payee shape/mismatch, and native constrained-client budget-path construction without a request. They do not run this owner bootstrap against live PayPal, a real tunnel or registration. Existing focused PostgreSQL tests separately cover the core runtime's writer, journal, event and crash behavior. End-to-end live bootstrap execution remains NOT_TESTED pending owner authorization; do not turn these unit tests into a live PASS.

## Latest offline qualification and diagnostics

Node22 qualification now includes actual disposable-PostgreSQL initialization of both reference stores and SQLite proof, no overwrite, and zero provider-client construction. Source-bound owner expiry is rechecked at every public ingress. Request reservations persist before fetch; sanitized response/transport metadata persists in the budget evidence sidecar, never credentials/tokens/body/signature headers. A sidecar write failure consumes its request slot and closes the client to further requests. A new review bundle carries exact source identities and logs. Live session/tunnel/PayPal execution remains NOT_TESTED.
