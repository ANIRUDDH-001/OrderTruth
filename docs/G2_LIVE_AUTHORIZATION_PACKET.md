# G2 live authorization packet — offline live-ready candidate, NOT authorized

The executable is `scripts/lab-reference-sandbox.ts`; entry/source/config schema and owner commands are documented in G2_BOOTSTRAP.md. No live invocation, provider or model request, registration change or spend occurred during qualification. Independent review and explicit owner approval of this NEW source identity are required before execution. An approval JSON is a local operator record, not cryptographic proof of owner identity; do not manufacture one on the owner's behalf.

## Exact implemented provider budget

Runner supports **reusing an existing owner-approved Sandbox registration only**. Fixed host `https://api-m.sandbox.paypal.com`, no fetch/provider/API-base override, no redirects. Budget reservations are durable, locked and fsynced BEFORE outbound requests; errors/uncertain responses consume slots. Public operations are prechecked before OAuth. Counters survive process restart and never automatically reset.

| Operation | Maximum per approved run |
|---|---:|
| OAuth POST /v1/oauth2/token | 3 |
| POST /v2/checkout/orders | 1 |
| POST /v2/checkout/orders/{id}/capture | 1 |
| GET /v2/checkout/orders/{id} (pre-approval, pre-capture, processor, return, webhook and replay reads combined) | 12 |
| POST /v1/notifications/verify-webhook-signature | 5 |
| GET /v1/notifications/webhooks/{approvedId} | 1 |
| Registration creation/deletion | 0 / 0 |
| **Total outbound server API requests** | **23** |

Exactly one USD1.00 CAPTURE-intent order, manual Sandbox buyer approval, then one explicitly requested capture at most. Real-money ceiling ₹0; no billing/trial/card/paid service. No refunds, voids, payouts, subscriptions or second purchase. No automatic retry of capture: uncertainty requires GET readback and owner assessment. The lower-level constrained client separately tests temporary-registration ceilings1create/1GET/1delete/25total, but that is NOT an executable runner option and is NOT part of this proposed permission. If there is no usable approved registration, STOP for a separately scoped registration decision; do not silently enable a temporary registration.

## Required owner configuration before any request

1. Independently review the new source snapshot/finding mapping. Obtain `--source-identity` output and approve that exact G2 source SHA. This mode reads only known G2 sources, not credentials, G3 or private holdouts, and makes no provider call.
2. Owner supplies an existing free HTTPS tunnel, loopback local port and exact `/webhooks/paypal` URL. Only that single webhook route is exposed. No checkout/capture/refund/debug/admin route or database port. No hosted V2 settings change. Registration must belong to the approved Sandbox app, match the approved URL and subscribe to PAYMENT.CAPTURE.COMPLETED and CHECKOUT.ORDER.APPROVED. The first session reads registration once; restart uses the explicitly recorded receipt, not a fresh registration read. External registration drift after that is NOT automatically qualified.
3. Locally configure gitignored `.env`: explicit PAYPAL_ENV=sandbox, fixed PAYPAL_API_BASE, app client ID/secret, LAB_PG_ADMIN_URL pointing ONLY to loopback `/postgres`, and distinct 32-byte hex LAB_CAPABILITY_KEY_CROSS_PATH / LAB_CAPABILITY_KEY_CORRECTED. Never paste values into chat. The runner refuses the hosted URL and unrelated environment API overrides. It never loads .env on import or during source-identity mode.
4. Place a sanitized hash-bound payee preflight below `.work`, shape `{provenance:"OFFLINE_RECORDED_MOCK",readback:{purchase_units:[{payee:{merchant_id:"OWNER_EXPECTED_PAYEE"}}]}}`. It tests exact merchant_id schema/identity before a purchase; email-only, missing, multiple-unit and wrong-payee inputs fail. Mocks do not prove actual account compatibility. Use an owner-validated sanitized prior readback if available; real account compatibility remains unproven until genuine GET. The runner additionally checks the actual order payee before capture, without a second purchase.
5. Owner creates the strict approval artifact under `.work` with runId, source SHA, exact merchant/payee/registration/URL/port, approvedAt/expiresAt (<=24h), explicit action list, USD100 minor units, ₹0 maximum, registrationMode=reuse and payee-preflight path/SHA. Include only specifically authorized actions. Approval expiry is checked on every public ingress and private command. No action is inferred from a file merely being present.

## Isolated initialization and execution AFTER approval

Owner commands (not run against real provider during implementation):

```text
node --import tsx scripts/lab-reference-sandbox.ts --source-identity
node --import tsx scripts/lab-reference-sandbox.ts --action initialize --approval .work/owner-g2-approval.json --execute
node --import tsx scripts/lab-reference-sandbox.ts --action session --approval .work/owner-g2-approval.json --execute
```

Initialization creates only two new named local otg_* databases for the vulnerable/fixed reference stores and one separate SQLite checkout/proof store. Existing schema/data is refused. Node22 disposable-PG qualification verified initialization and no-overwrite behavior with **zero provider-client constructions**. It does not authorize initialization on owner infrastructure without the required artifact.

One persistent session shares native client/token and request journal. Local stdin commands: create-order; manually approve using Sandbox buyer; capture-approved-order BUYER_APPROVED; invoke-return cross-path; events; invoke-return corrected; replay-webhook corrected WH-...; budget; stop. Return/replay receipts state **LOCAL_BOOTSTRAP_INVOCATION**, not browser return or a second genuine webhook. Genuine delivery automatically invokes the cross-path writer through authenticated intake/processor/readback. Delivery may precede local return; record the observed ordering. No injectDuplicate endpoint is used.

APPROVED events never create Lab orders. Repeated exact bytes of an already authenticated stored event do not make another signature postback; this acknowledges existing evidence, not authentication of a new transmission. Terminal ignored/foreign/disagreed events return terminal acknowledgments. Transient processing/readback/local errors retain retry without re-verifying the same known bytes. Changed bytes require verification. All requests still pass mechanical caps. Distinct event IDs for the same capture are tested separately from repeated event IDs.

## Evidence, stop and cleanup

Retain exact source/approval identity, operation counts, sanitized UTC request/debug/status metadata, provider readback hashes and capture/order/intent/payee/amount agreement, signature SUCCESS/first-delivery linkage, durable handler attempts, journal/guard outcomes and final Lab rows. Provider-readback, genuine verified event, local bootstrap replay, offline mock and merchant rows remain different evidence classes. Sandbox runtime accepts only native-factory WeakSet-branded clients, never offline/fake providers or test authority. Offline mode cannot mint PAYPAL authority.

The request budget and sanitized evidence sidecar are append+fsync logs without tokens/credentials/bodies/signatures. Evidence-write failure retains spent quota and closes that client to further requests. Stale lock/corrupt/incomplete journal requires manual inspection, never deletion to regain quota. Process kill test receipts explicitly retain SIGKILL, stderr (empty in the successful run), committed order/no receipt before restart and REUSED/one receipt after restart.

Stop on production configuration, source/approval/expiry mismatch, cap exhaustion, actual cost, unexpected mutation, payee/amount/capture inconsistency, missing authoritative capture, signature failure/unavailability or unclear registration ownership. Stop/EOF/SIGINT/SIGTERM closes local resources; SIGKILL cannot clean up and preserves stale lock/data for owner inspection. Stop the owner-selected tunnel separately. Do NOT delete the reused registration. Cleanup only the newly named disposable experiment stores after evidence export, with separate approval if required; no hosted or historical data deletion.

Never store/share bearer/OAuth tokens, secrets, capability MACs/keys, signature headers, buyer credentials/PII or raw provider payloads. A passing mock test or the construction of a native client is not a genuine Sandbox result. Live PayPal/tunnel/session delivery, model usage and arbitrary application-patch qualification remain NOT_TESTED. Model approval is separate from this packet.

## Final pre-approval correction

After creation and BEFORE returning approveUrl, a bounded counted GET by the trusted configured Sandbox client must verify the exact order ID and expected payee.merchant_id. Successful readback creates a flushed source/run/order/intent/payee-bound receipt. Capture requires that receipt and still performs its existing fresh pre-capture GET. The owner-written recorded/mock file remains a preliminary schema test only, not genuine provider verification.

Wrong/missing/unverifiable identity, failed GET or exhausted budget yields no approval URL and blocks capture. Failed/uncertain creation or failed preflight retains its original checkout claim: restart cannot silently create another order or reset budgets/claims. Old source-bound ready files halt on source mismatch. A missing success receipt halts capture rather than retrying financially.

The added pre-approval GET counts within12GETs and23total, unchanged. The earlier whole clean flow9GETs is expected to become10if otherwise unchanged; no new live measurement is claimed. Real Sandbox pre-approval merchant_id availability remains NOT_TESTED and may prevent the experiment entirely. No inferred identity fallback, second purchase, live provider call or buyer approval was performed for this correction.
