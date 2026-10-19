# Gate 1B — single live Sandbox capture with a genuine webhook

**Status: this experiment's pass criteria were all met (VERIFIED-LIVE, one run).** The open follow-up risks are in §7. The final Gate 1B decision is yours.

- **Reviewed base:** HEAD `2fc9586`, clean tree, no code changes in this run.
- **Window:** 2026-10-19, 02:46Z–02:56Z.
- **Evidence:** `.work/runs/gate1b-capture/` (ignored). Listener and tunnel logs are in `.work/runs/gate1b-tunnel/04-listener.log` (from line 24 onward) and `01-cloudflared.log`.
- **Authorization used:** exactly one USD 1.00 Sandbox checkout and at most one capture POST. The buyer approval was manual and done by the user. No second order, refund, resend or Stage 1C work, and no Git writes by Claude.

## 1. Preflight (all non-mutating)

| Check | Result | Evidence |
|---|---|---|
| Tunnel | Same Quick Tunnel still up: PID 56540, origin `https://breeds-accommodation-ten-rrp.trycloudflare.com` → `http://127.0.0.1:3002`, 0 ERR lines | `gate1b-tunnel/01-cloudflared.log` |
| Listener | PID 20836, bound to `127.0.0.1:3002` only. Port 3001 was not listening before the test | netstat in session log |
| Route isolation through the public origin | 5/5 → 404: `GET /`, `GET /webhooks/paypal`, `POST /api/orders`, `GET /api/health`, `GET /api/paypal/browser-config` | `02-route-isolation.txt` |
| Registration | `webhook-check` ok=true, HTTP 200, debug_id `ca4cc74d9e960`. URL matches. Types: APPROVED, CAPTURE.COMPLETED / PENDING / DENIED | `03-webhook-check.json` |
| Same REST app | The registered webhook id was readable with this app's OAuth credentials, and webhooks are scoped per app. `PAYPAL_ENV` and `PAYPAL_API_BASE` equal the Sandbox values (env-audit; names and status only) | session log |
| DB (logical, read-only) | integrity_check ok, quick_check ok, 0 FK violations, WAL, schema v3. 8 awaiting + 1 captured, 25 evidence rows, 9 intents (0 with a checkout key, so nothing could be reused). Inbox: 1 rejected delivery, 0 events, 1/5000 | `00-db-health.json`, `01-status-before.json` |
| Code | typecheck 0, tests 284/284 | `04-check.txt` |
| Price | Set by the server: `GATE0_PRODUCT` USD, minor 100 | `src/domain/checkout.ts` |

## 2. Experiment timeline (UTC)

| Time | Actor | Observation |
|---|---|---|
| 02:49:48.962 | checkout server (`pnpm start`, PID 15956, `127.0.0.1:3001`) | `startup_reconcile` outcomes=0, so no PayPal call |
| 02:51:24.868 | user's browser → `POST /api/orders` | one new intent and attempt |
| 02:51:25.955 | server → PayPal create order | **201**, debug `ca4cc7b1bcaeb`, 636 ms. Order `7TS74882M0297892Y` |
| ~02:51–02:52 | **user** | signed in as the US Sandbox buyer and approved in the PayPal popup (Claude entered no credentials) |
| 02:52:18.182 | browser `onApprove` → `POST /api/orders/7TS74882M0297892Y/capture` | **the only capture request** |
| 02:52:19.508 | pre-capture GET | 200, debug `ca4cc7c66f874`, 1323 ms |
| 02:52:21.437 | **capture POST** (stored `PayPal-Request-Id`) | **201**, debug `ca4cc7c6e7dd8`, 1926 ms. Capture `79N705976G542051J` |
| 02:52:21.987 | post-capture GET | 200, debug `ca4cc7c7acabe`, 542 ms. Verdict `captured` |
| 02:52:22.239 | PayPal | `CHECKOUT.ORDER.APPROVED` event `create_time` (**after** the capture completed) |
| 02:52:25.482 | PayPal | `PAYMENT.CAPTURE.COMPLETED` event `create_time` |
| 02:52:28.266 | listener, delivery 2 | APPROVED received, then postback **SUCCESS** (792 ms, debug `ca4cc7ca7de61`), then HTTP 200 |
| 02:52:30.531 | processor | APPROVED event: readback (200, debug `ca4cc7caa7fa1`) then `processed`, "readback applied; attempt state captured" |
| 02:52:41.807 | listener, delivery 3 | CAPTURE.COMPLETED received, then postback **SUCCESS** (406 ms, debug `ca4cc7cfa1cf4`), then HTTP 200 |
| 02:52:42.756 | processor | CAPTURE.COMPLETED event: readback (200, debug `ca4cc7cfcad46`) then `processed`, "readback applied; attempt state captured" |
| 02:54:0x | Claude, `pnpm cli readback` (separate process, GET only) | 200, debug `ca4cc7fa90cbb`. Order COMPLETED, capture COMPLETED, USD 1.00, custom_id and order id match the intent |
| 02:55:04 | Claude | teardown (§5) |

## 3. Webhook evidence (sanitized)

| Field | Delivery 2 | Delivery 3 |
|---|---|---|
| Event id | `WH-1NG46012R3628551T-67U93725A3753941E` | `WH-2W029761NA509782X-1TN43801VW6819635` |
| Type / resource | `CHECKOUT.ORDER.APPROVED` / checkout-order | `PAYMENT.CAPTURE.COMPLETED` / capture |
| Required headers (5) | all present* | all present* |
| Cert URL host | on the allowlist* (exact host **NOT RECORDED**) | on the allowlist* (exact host **NOT RECORDED**) |
| transmission_time → our receipt | 02:52:22Z → +6.3 s | 02:52:33Z → +8.8 s |
| event create_time → our receipt | 6.0 s | 16.3 s |
| Body | 2902 B (stored only as sha256) | 1618 B (stored only as sha256) |
| Postback `verification_status` / latency | SUCCESS / 792 ms | SUCCESS / 406 ms |
| HTTP returned to PayPal | 200 | 200 |
| Dedup state | first delivery, `deliveries`=1, no redelivery | first delivery, `deliveries`=1, no redelivery |
| Event state / process attempts | `processed` / 1 | `processed` / 1 |
| Linked to local attempt | yes | yes |

\* **Inferred from code, not logged per header.** A delivery reaches `verified` only after these steps in `src/webhooks/intake.ts`:
- `parseTransmissionHeaders` requires all five `PAYPAL-*` headers and the cert-URL host allowlist (`api.sandbox` / `api-m.sandbox` plus the certs path).
- The 1 h window check passes.
- The postback returns SUCCESS.

The intake stores neither which allowlisted host was used nor the header values. Signatures and cert URLs are not persisted or logged (checked: 0 hits in 11 persisted summaries).

**Approval event versus capture event.** These are kept apart by `event_type` and `resource_type`. In this run, PayPal emitted `CHECKOUT.ORDER.APPROVED` 0.8 s **after** our capture had completed. Because processing goes through a readback, the approval event did not move state backwards; the readback already showed the order as captured. The `PAYMENT.CAPTURE.COMPLETED` event's capture id was present in the readback, and the amount and custom_id agreed (`eventAgreesWithReadback`).

**Unsolicited traffic.** Four unrelated `GET` requests reached the public origin after the test (02:52:45–02:53:55), probably scanners. All got 404, and none was stored or rate-limited.

## 4. Pass / fail

| Requirement | Observed | Result |
|---|---|---|
| Sandbox amount USD 1.00 | create, capture readback, local `captured_minor`=100, independent readback | PASS |
| At most 1 capture POST | server log: 1 `POST …/capture` request and 1 `capture_order` op; `capture_claims`=1 | PASS |
| PayPal order and capture COMPLETED | post-capture readback and independent CLI readback | PASS |
| Provider readback agrees with local amount, currency and correlation | verdict reasons: "capture COMPLETED; amount, currency and order id match intent"; custom_id check passed | PASS |
| Genuine capture event received, postback SUCCESS, persisted, processed | delivery 3 / event `WH-2W02…` `processed` | PASS |
| Webhook handler issues no PayPal financial mutation | listener ops: 2× `webhook_readback` (GET) and 2× verify-webhook-signature postbacks only; no capture or refund code path in `src/webhooks/` | PASS |
| No second payment, refund or resend | none issued | PASS |
| `disagreed` / verification failure / missing delivery | none occurred | n/a |

## 5. Teardown and post-test

- **Graceful stop: FAILED, then forced.** Plain `taskkill /T` (no `/F`) was refused by Windows for all three detached console process trees ("can only be terminated forcefully"). Each tree was then stopped with `taskkill /T /F`, in this order: checkout server 15956, listener 20836, cloudflared 56540. Afterwards there were no node or cloudflared processes, and 3001, 3002 and 20241 showed only TIME_WAIT (`11-teardown.txt`). A truly graceful stop needs a console-attached Ctrl+C or a shutdown hook; that is not implemented.
- **Tunnel URL:** dead now that cloudflared is stopped.
- **Webhook registration:** the user must delete it in the Sandbox dashboard. Claude cannot change the account. **Status: see §8.**
- **DB after the test (logical, read-only):**
  - integrity ok, quick_check ok, 0 FK violations, WAL, schema v3
  - 8 awaiting + **2 captured**, 34 evidence rows
  - deliveries: 1 rejected + 2 verified; events: 2 `processed`; inbox 1/5000 (`12-db-health-after.json`, `10-status-after.json`)
- **Backup:** `VACUUM INTO` → `.work/backups/ordertruth.post-capture.<ts>.sqlite`, integrity ok, same counts (`13-backup.txt`).
- **Secret scan** of 17 evidence and log files: 0 hits, client id present in 0 files.
- **Finding (risk 4 confirmed):** the main `.sqlite` file's sha256 is `96b217bb…` before the tunnel phase and after this test, the same value, even though 9 evidence rows, 2 deliveries and 2 events were added. All the new data sits in the un-checkpointed `-wal` file. A file hash says nothing about logical state. Use integrity checks plus logical row counts, or a `VACUUM INTO` snapshot hash.

## 6. Provider calls and cost

| Caller | Calls | Kind |
|---|---|---|
| Preflight `webhook-check` | 1 OAuth + 1 GET webhook | read |
| Checkout server | 1 create order POST, 1 capture POST, 2 order GETs (+ OAuth, cached per process; the count is not logged) | **1 financial mutation (capture)** |
| Webhook listener | 2 verify-webhook-signature POSTs, 2 order GETs (+ OAuth, cached) | verification and read |
| CLI independent readback | 1 OAuth + 1 order GET | read |
| Browser | PayPal JS SDK and popup traffic (PayPal-hosted) | user approval |

**Actual spend: ₹0.** The money was virtual Sandbox funds, and no paid service was used.

## 7. Open risks (from the independent review; none fixed in this run)

1. **A stale GET can make a genuine capture event terminally `disagreed`.** It did not happen here: the readback 0.9 s after receipt agreed. One run proves nothing about the race. Proposed fix: a bounded retry or backoff before `disagreed`, and/or making `disagreed` re-checkable by the reconciler.
2. **The 1 h transmission window may reject legitimate delayed redeliveries.** Not exercised: both deliveries arrived within 9 s and got 200, so PayPal had no reason to retry. Whether retries reuse `transmission_time` remains a **HYPOTHESIS** (T3). Options (a)–(d) are in `GATE1B_LIVE_PREFLIGHT.md` §4. Nothing was changed.
3. **The inbox ceiling is check-then-insert,** not transactionally strict across concurrent arrivals. Unchanged.
4. **A DB file hash is not proof of logical SQLite state.** Confirmed live (§5).
5. **No permanent public deployment or judge-ready hosting.** The Quick Tunnel was ephemeral and is gone.

Also recorded:
- **Graceful shutdown of detached processes on Windows is not achievable with `taskkill` without `/F`** (§5).
- **The exact cert-URL host and header-presence are not logged per delivery,** so they are inferred from the code path (§3). Logging the allowlisted host name would close this.

## 8. Remaining user actions

- Delete or disable the temporary webhook in developer.paypal.com → Apps & Credentials → **Sandbox** → this REST app → Webhooks. Its URL is now dead. Afterwards, clear `PAYPAL_WEBHOOK_ID` in `.env` locally if you want the listener to refuse to start.
- **Registration status at the time of writing: still registered (PENDING USER ACTION).**
