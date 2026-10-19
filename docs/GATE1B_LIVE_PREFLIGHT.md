# Gate 1B — final hardening and live-tunnel preflight

Status: **Phase A done (VERIFIED-LOCAL, PayPal MOCKED). Phase B local preflight done. The public tunnel is NOT activated.** Live Sandbox postback: **NOT TESTED**.

Reviewed base: HEAD `fdc7cfc` plus the uncommitted working tree described in §8. Evidence: `.work/runs/gate1b-live/`.

## 1. Pre-persistence rate limit and durable ceiling

| Layer | Where | Behaviour | Status |
|---|---|---|---|
| Exact-route check | `onRequest` hook 1 | Anything other than `POST /webhooks/paypal` (exact target, no query) → 404. It spends no rate-limit token. | VERIFIED-LOCAL (R5, preflight) |
| Global token bucket | `onRequest` hook 2, before body parsing and any DB write | 60/min refill, burst 30 (`WEBHOOK_RATE_PER_MIN`, `WEBHOOK_RATE_BURST`). Over the limit → **429 + `Retry-After`**, no row, no postback. | VERIFIED-LOCAL (R1–R4, R6, preflight) |
| Durable ceiling | Intake, before `recordDelivery` | When the stored non-verified deliveries (received_unverified, rejected, retryable_failure, abandoned, duplicate) reach `WEBHOOK_MAX_STORED_UNVERIFIED` (default 5000) → **503 `inbox_ceiling`**, no row. Holds across restarts. Verified first deliveries never count. | VERIFIED-LOCAL (R7, R8) |
| Bounded noisy logs | 404 and 429 lines | 20 lines per 10 s window, then one suppressed-count line. | VERIFIED-LOCAL (R9) |

- **Why a global bucket and not per-IP?** Behind cloudflared every request arrives from loopback, and PayPal sends from many addresses.
- **Both refusals are retryable non-2xx.** PayPal documents up to 25 retries over 3 days for any non-2xx. A throttled genuine delivery is therefore delayed, not lost (R6). The Gate 1A readback reconciler still covers payment state.
- **Accepted trade-off (HYPOTHESIS for real-world impact):** anyone who learns the random `trycloudflare.com` URL can exhaust the bucket or the ceiling. This delays genuine deliveries but cannot create events, because only a postback-verified delivery can, and that is DB-enforced. The tunnel is short-lived.
- **Worst-case growth** is about 60 rows/min, capped at 5000 rows of ≤ 64 KiB each (about 320 MB worst case, usually under 1 MB).

## 2. Retention policy (defined, deletion NOT implemented)

- **Now: keep everything.** The no-delete triggers on deliveries, events, transitions and audit stay in place.
- **The ceiling is what bounds growth;** retention does not.
- **Rows that are never prunable:**
  - every event row, plus its first delivery
  - any delivery or event that is pending, processing, retryable, failed or disagreed
  - every transition and audit row
- **Proposed rule for later; it needs a backup, explicit approval, and a migration that relaxes the no-delete trigger for only this predicate:** delete `rejected`, `abandoned`, `retryable_failure` and `duplicate` deliveries that are older than 30 days and are not the `first_delivery_seq` of any event.
- **Preview:** `webhook-status` already reports `retention.eligibleUnderProposedPolicy` and `protected`, so the effect can be checked before anything is deleted. (S4)

## 3. Read-only status command

```bash
pnpm cli webhook-status
```

- Opens SQLite with `readOnly: true`. It never migrates; on a schema older than v3 it exits with a clear message. The DB file stays byte-identical (S3). It is safe to run beside a live listener.
- **Reports:**
  - pending / verified / processed / rejected / retried / failed counts
  - deliveries by state and rejection reason
  - redelivered and multi-attempt events, and the oldest pending event's age
  - ingress usage against the ceiling, and the retention preview
  - the last 10 events (id, type, state, counts, outcome)
- **Never includes:** credentials, the webhook id, payloads, payer or payee data, signatures or correlation ids (S2).

```bash
pnpm cli webhook-check https://<random>.trycloudflare.com
```

This is one read-only `GET /v1/notifications/webhooks/{id}` call. It confirms that the configured id exists for this Sandbox REST app, that its URL equals `<origin>/webhooks/paypal`, and that it subscribes to `PAYMENT.CAPTURE.COMPLETED`. It also lists any missing recommended types. It never prints the id. It exits 5 on a mismatch. (W1, W2)

## 4. Transmission-time window: 1 h kept for the first diagnostic

| Test | Result |
|---|---|
| T1: genuinely signed delivery 1 h + 1 s old | 400 `transmission_expired`, **no postback**, no event |
| T2: exactly 1 h old | accepted |
| T3: a retry that reuses the original time after our 503 | rejected once older than 1 h; the event is never stored by webhook (the readback reconciler still covers it) |
| T4: a redelivery with a fresh time | accepted as `duplicate`; a stale copy is rejected and does not disturb it |
| T5: config | default 1 h; maximum 4 days; nothing widened |

The official docs do **not** say whether retries reuse `transmission_id` and `transmission_time`, and they give no freshness window, so T3 stays a **HYPOTHESIS**. The first live redelivery answers it.

**Options to pick from after that test:**

- **(a) Keep 1 h.** Correct if each retry carries a fresh time. The tightest replay window.
- **(b) Widen to about 3 days** (`WEBHOOK_MAX_TRANSMISSION_AGE_MS=259200000`, within the 4-day cap) to match the retry schedule. A replay is still harmless: it needs a valid PayPal postback, and the event-id dedup is DB-enforced.
- **(c) No age window.** Rely on the postback, event-id dedup and readback-based idempotent processing. Simplest, but it gives up a cheap early reject.
- **(d) Record stale deliveries as "late" without verifying,** for later manual resend via `POST /v1/notifications/webhooks-events/{id}/resend`. More code; only worth it if (a) proves wrong and (b) is unwanted.

Recommendation: keep (a) for the diagnostic and switch to (b) if live retries reuse the original time.

## 5. Official-docs recheck (2026-10-19, developer.paypal.com webhooks v1 schema)

| Item | Docs say | Our code | Status |
|---|---|---|---|
| Headers | `PAYPAL-TRANSMISSION-ID/-TIME/-SIG`, `PAYPAL-CERT-URL`, and `PAYPAL-AUTH-ALGO` (described in the v1 field descriptions) | requires all 5 | resolved; the previous HYPOTHESIS on auth-algo is answered by the docs. **Presence on real deliveries: NOT TESTED** |
| Postback body | 7 required fields: auth_algo (alnum, ≤100), cert_url (uri, ≤500), transmission_id (≤50), transmission_sig (≤500), transmission_time (date-time), webhook_id (alnum, ≤50), webhook_event | matches; raw event bytes embedded | VERIFIED against docs |
| Response | `verification_status` SUCCESS or FAILURE | anything else → 503 retryable | VERIFIED against docs |
| Retries | up to 25 times over 3 days on non-2xx | 429/503 rely on this | VERIFIED against docs |
| Cert URL host | example `api.sandbox.paypal.com/v1/notifications/certs/…` | allowlist `api.sandbox` / `api-m.sandbox` + that path; the URL is never fetched (postback mode) | allowlist matches the docs example; real host **NOT TESTED** |
| Retry reuse of id/time | not documented | §4 | HYPOTHESIS |
| Webhook lookup | `GET /v1/notifications/webhooks/{id}` returns id, url, event_types | `webhook-check` | VERIFIED against docs, MOCKED in tests |

## 6. Phase B local preflight (loopback only, no tunnel, zero PayPal calls)

- **Setup:**
  - The listener ran against a VACUUM copy of the real DB in the scratchpad, using env overrides `DATABASE_URL` and a dummy `PAYPAL_WEBHOOK_ID`.
  - Startup makes no PayPal call.
  - Only requests that fail local checks before the postback were sent.
- **Results:**
  - **Binding:** `127.0.0.1:3002` only (netstat). Nothing listening on 3001.
  - **Off-route requests:** `GET /`, `GET /webhooks/paypal`, `POST /api/orders`, `POST /api/checkout`, `/health`, `/debug`, path traversal and a query string all return **404**. There is no proxy, no debug endpoint and no checkout route.
  - **Local rejects:**
    - missing signature → 400 `missing_headers`
    - foreign cert host → 400 `cert_url_not_allowed`
    - 2 h-old time → 400 `transmission_expired`
    - text/plain → 415, not stored
    - 70 KB body → 413, not stored
  - **Flood:** 60 requests gave 25×400 then 35×429 with `Retry-After: 1`. Exactly 28 rows were stored (3 probes + 25), and `webhook-status` agreed.
  - **Logs:** 62 lines, with rate-limited lines capped at 20. Secret scan of logs and evidence: 0 hits; dummy id in logs: 0.
  - **Shutdown:** the process tree was stopped cleanly and the ports were freed. The real DB's sha256 was unchanged before and after.
- **Main API:** `src/server/main.ts` hard-codes host `127.0.0.1`. The webhook runtime refuses non-loopback hosts, and refuses `WEBHOOK_PORT == PORT`.

## 7. Tunnel instructions (for you to run, only after you approve)

Everything below happens on your machine. Claude never reads `.env` and never needs the webhook id.

1. **Back up the DB** (no listener running):
   ```bash
   node .work/scripts/db-backup.mjs .work/ordertruth.sqlite .work/backups/ordertruth.pre-tunnel.sqlite
   ```
2. **Install cloudflared** (official, free, no account):
   ```bash
   winget install --id Cloudflare.cloudflared
   ```
3. **Start the Quick Tunnel to the webhook port only** (never 3001; no `--allowed-mail`, no config file, no login). Keep this terminal open for the whole test:
   ```bash
   cloudflared tunnel --url http://127.0.0.1:3002
   ```
   Copy the printed `https://<random>.trycloudflare.com` origin. It changes on every run.
4. **Register the webhook.** In developer.paypal.com → Apps & Credentials → **Sandbox** → this REST app → Webhooks → Add:
   - URL: `https://<random>.trycloudflare.com/webhooks/paypal`
   - Events: `PAYMENT.CAPTURE.COMPLETED`, `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`
5. **Add the webhook id to `.env`.** Edit `.env` locally and set `PAYPAL_WEBHOOK_ID=<Webhook ID>`. Do not paste it in chat.
6. **Check the registration** (one read-only Sandbox GET):
   ```bash
   pnpm cli webhook-check https://<random>.trycloudflare.com
   ```
   Expect `"ok": true`.
7. **Start the listener** in a second terminal. Expect `webhook_listening` on `127.0.0.1:3002`:
   ```bash
   pnpm webhooks
   ```
8. **Check from outside, through the tunnel:** these must all return 404. The checkout app must log nothing.
   ```bash
   curl -s -o NUL -w "%{http_code}\n" https://<random>.trycloudflare.com/
   ```
   ```bash
   curl -s -o NUL -w "%{http_code}\n" -X POST https://<random>.trycloudflare.com/api/orders
   ```
9. **Watch the inbox at any time:**
   ```bash
   pnpm cli webhook-status
   ```
10. **Shut down:** Ctrl+C the listener, then Ctrl+C cloudflared. Afterwards, delete or disable the webhook in the Sandbox app, because its URL is now dead.

Phase C (the USD 1 Sandbox capture and redelivery test) needs your **separate** approval.

## 8. Files

- **New:**
  - `src/webhooks/rate-limit.ts`, `status.ts`, `registration.ts`
  - `tests/gate1b-hardening.test.ts` (26 tests)
  - this document
- **Modified:**
  - `src/webhooks/app.ts`, `intake.ts`, `inbox.ts`, `runtime.ts`
  - `src/config.ts`, `src/paypal/client.ts` (`getWebhook`), `src/cli.ts`
  - `tests/fake-paypal.ts` (fake webhook lookup)
  - `.env.example` (commented defaults)
  - `docs/GATE1B_SECURITY_AND_RESULTS.md`, `docs/QUALITY_GATE_MATRIX.md`
- No migration and no new dependency. Schema stays v3.
