# Gate 1B: offline webhook infrastructure, security and results (sanitized)

**Date:** 2026-10-19 · **Author:** Claude Code (Opus 5.5) · **Baseline:** HEAD `db61aa5` (clean tree, 88/88) · **Scope:** Stage 1B offline only.

This gate had no tunnel, no webhook registration, no Sandbox call of any kind, no capture, no Stage 1C, no fault lab, no repair, no AI and no UI. **CLAUDE MADE NO GIT WRITES.**
Raw local logs are in `.work/runs/gate1b/` (gitignored). **This is not production certification.** Every PayPal behaviour in this gate is **MOCKED** (see §11).

```
STATUS: Stage 1B offline — implemented and tested locally; provider MOCKED. STOPPED before any tunnel.
VERIFIED: §3 (commands and observed results)
NOT TESTED: §10, §11
IMPLEMENTED: §1
TESTS: 258 passed / 0 failed / 0 skipped (88 baseline + 170 new); 0 pre-existing tests changed
RISKS: §11
COST / QUOTA: ₹0; 0 PayPal Sandbox calls; 0 Gemini calls; no paid service, no new dependency
BLOCKING QUESTIONS: §12 (needed before the tunnel, not before review)
NEXT ACTION: you review this report and the diff; approve or amend the tunnel activation (§13)
GIT: status only; CLAUDE MADE NO GIT COMMITS
```

## 1. File changes and rationale

| File | Change | Why |
|---|---|---|
| `src/webhooks/app.ts` (new, 77 lines) | Dedicated Fastify instance with exactly one route, `POST /webhooks/paypal`. An `onRequest` hook does an exact raw request-target match (`req.raw.method === "POST" && req.raw.url === "/webhooks/paypal"`), so anything else gets 404. It uses an `application/json` buffer parser only. It sets no HEAD routes, a case-sensitive router, no slash folding, server-generated correlation ids, and `nosniff` / `no-store` / `no-referrer` headers. Unknown errors return 503. | This is the future tunnel target. It must expose nothing but the webhook, and it must keep the raw bytes PayPal signed. |
| `src/webhooks/event.ts` (new, 143) | Header parsing (single-valued, schema patterns and lengths), Sandbox cert-URL allowlist, `EventSchema` (zod), `summarizeEvent` (allowlist of minimised fields), and `claimedIdentity` (bounded hints taken from an unverified body). | These checks bound what we forward and store. **None of them establish authenticity.** |
| `src/webhooks/verifier.ts` (new, 64) | `PayPalPostbackVerifier`: `POST /v1/notifications/verify-webhook-signature` with the event embedded byte-for-byte. It has an end-to-end deadline that also covers the OAuth token fetch. Anything other than `SUCCESS`/`FAILURE` maps to `UNAVAILABLE`. | Official Sandbox postback verification. |
| `src/webhooks/inbox.ts` (new, 173) | Durable delivery rows, `acceptVerified` (one transaction: delivery → verified/duplicate, plus event row, plus evidence), leasing via atomic `UPDATE … RETURNING`, `finishEvent` guarded by `process_attempts`, and `abandonStale`. | Durable acknowledgement, dedup and crash recovery. |
| `src/webhooks/intake.ts` (new, 141) | The delivery pipeline: record → structure/headers/window → postback → commit → 200. | No 2xx before the event is durable. Nothing in this path mutates payment state. |
| `src/webhooks/processor.ts` (new, 158) | Asynchronous processing after the 2xx: ownership check, a pre-readback custom_id check, `readbackIf` with an agreement predicate, backoff, and a max-attempts cap. | A verified event changes state only if the order is ours and the authoritative readback agrees. |
| `src/webhooks/runtime.ts` (new, 80), `main.ts` (new, 25) | Assembly (refuses to start without a webhook id). Startup order is: abandon stale deliveries → drain → listen on loopback → 30 s sweep. Refuses a non-loopback host or `port === PORT`. | Restart recovery; isolation from port 3001. |
| `src/db/store.ts` (+89) | Migration 3 adds `webhook_deliveries`, `webhook_events`, a static `webhook_transitions` table (13 rows), and an append-only `webhook_audit` table. Triggers enforce initial states, legal transitions, and no deletes. **An event row can only be inserted if it is backed by a `verified` delivery with the same id.** The evidence class gains `PAYPAL_VERIFIED_WEBHOOK`. | The database itself enforces the trust rules, not only application code. |
| `src/checkout-service.ts` (+34/−few) | The `readback()` logic is extracted into `#applyReadback` (behaviour unchanged; the Gate 1A tests still pass). New `readbackIf(orderId, corr, accept)` applies the readback only if `accept(raw)` returns null. New `ownsOrder(orderId)`. | The webhook path reuses the Gate 1A readback-only state change. It gets no new way to mutate payments. |
| `src/paypal/client.ts` (+17) | `rawJson` body option, per-call `timeoutMs`, `verifyWebhookSignature`. The host is still pinned to the Sandbox base URL. | A byte-exact postback with a bounded duration. |
| `src/config.ts` (+31) | `WEBHOOK_HOST` (fixed to 127.0.0.1), `WEBHOOK_PORT=3002`, verify timeout (500–10000 ms, default 5000), body limit (1 KiB–256 KiB, default 64 KiB), transmission age (default 1 h), future skew (default 5 min). Rejects `WEBHOOK_PORT === PORT` and the simulator id `WEBHOOK_ID`. The webhook id is added to the redaction `secrets`. | Fail-closed configuration. |
| `.env.example` (+2), `package.json` (+1 script `webhooks`) | `WEBHOOK_PORT=3002`; `pnpm webhooks` starts the listener. | `.env` was **not** read or modified. |
| `tests/fake-paypal.ts` (+64) | Fake verify endpoint. In "signed" mode it HMACs `tid\|time\|webhookId\|crc32(raw body)`, so a re-serialised body fails just as it would at PayPal. Supports the modes FAILURE, hang, hang_ignoring_abort, 500, 400, malformed and network. | An adversarial mock that also proves byte preservation. |
| `tests/gate1b-*.test.ts` (5 new files), `tests/helpers/webhook-{fixtures,process}.ts` | 170 tests (§3). The process harness holds the crash hooks, so `src/` contains no test switch. | |

## 2. Threat model and trust boundaries

```
 Internet (future tunnel, NOT opened) ──► 127.0.0.1:3002  webhook listener (own process)
        UNTRUSTED: headers, body, method, target             │ 1 route, raw bytes, 64 KiB, 415/413/404
                                                             ▼
                        webhook_deliveries (received_unverified)   ◄── nothing trusted yet
                                                             │ postback (OAuth, Sandbox host only, 5 s)
                                                             ▼
                 PayPal says SUCCESS ──► one tx: delivery verified + event row + evidence ──► 200
                                                             │ (async, leased)
                                                             ▼
                 ours? custom_id matches? ──► authoritative GET /v2/checkout/orders/{id}
                                                             │ agrees with event?
                                                             ▼
                 payment_attempts transition (Gate 1A guarded transitions; readback wins)

 127.0.0.1:3001 checkout app: no webhook route, never reachable from the listener (no proxy, no import)
```

| Threat | Control | Test |
|---|---|---|
| Forged event (no or invalid signature) | Only a PayPal postback `SUCCESS` creates an event row, enforced by a DB trigger. `FAILURE` returns 400. | V3, V4, D5, M1 mutation |
| Cert-URL SSRF | Cert URL is allowlisted to Sandbox hosts and `/v1/notifications/certs/`, with no port, userinfo, query or fragment. It is **forwarded to PayPal and never fetched by OrderTruth**. The webhook code has no raw HTTP client (static scan). | H1 (11 cases), V6, route S1, M5 mutation |
| Webhook-id spoofing | Webhook id comes from config only and is never read from the request. The simulator id `WEBHOOK_ID` is refused. | V2, C2, S2 |
| Replay | Transmission window (1 h old / 5 min future). Inside the window, a replay is verified again and stored as a `duplicate`, so it is never processed twice. | R1–R4, M4 mutation |
| Dedup poisoning (an attacker sends event id X first) | Unverified rows never create the event row. The genuine X is accepted later. | D4, T4 |
| Concurrent duplicates | `INSERT … ON CONFLICT` on the event id inside one transaction; one SQLite writer. | D2 (20 concurrent), D3 (two connections) |
| False acknowledgement | 200 only after commit. Persistence failure → 503 `persist_failed`. Verification unavailable → 503. | P1–P4, T1–T3, M2/M11 mutations |
| Forged foreign order or custom_id | `ownsOrder` check, then a custom_id check before any readback, then the agreement predicate after readback. | W1–W4, M6–M8 mutations |
| Out-of-order / stale events | State follows readback, not the event. Gate 1A transitions never go backwards. | O1, O2, W7 |
| Route confusion / reaching 3001 | Exact raw-target match; 33 target variants and 8 methods tested on a real socket. No proxy; Host/X-Forwarded headers are ignored. | I4–I8, M10 mutation |
| Amplification / slow PayPal | Concurrency cap of 8 → 503 `verifier_busy`. Deadline covers token fetch and postback. | T1, T5, B3 |
| PII / secret leakage | Only an allowlisted summary is stored (ids, status, amount, custom_id). Raw body, signature and payer data are never stored or logged; only the body's SHA-256 is kept. | S1, E1, E2, secret scan |
| Correlation-id injection | Ids are server-generated (`wh_<uuid>`); the inbound header is ignored. | S2 |

## 3. Test commands, counts and evidence (VERIFIED-LOCAL, provider MOCKED)

| Check | Command | Observed |
|---|---|---|
| Baseline before any change | `pnpm typecheck && pnpm test` at `db61aa5` | exit 0; 7 files, 88/88 (`.work/runs/gate1b/01-baseline.txt`) |
| Typecheck + full suite | `pnpm typecheck && pnpm test` | exit 0; **12 files, 258/258** (`02-full-suite.txt`) |
| Mutation checks (11) | `node .work/scripts/mutate.mjs` (mutate → targeted tests → restore, with an equality check) | **11/11 killed, 0 survived** (`03-mutations.txt`); sources restored byte-identical |
| Process-kill tests ×3 | `pnpm exec vitest run tests/gate1b-processes.test.ts` three times | **3/3 runs pass** (2/2 each; `06-processes-x3.txt`) |
| DB migration | `pnpm exec tsx .work/scripts/migrate-check.ts <db>` | §8 (`04-migration.txt`) |
| Secret scan | `node .work/scripts/secret-scan.cjs src tests docs …` (counts only) | §9 (`05-secret-scan.txt`) |

New tests by file:

| File | Count | Covers |
|---|---|---|
| `tests/gate1b-webhook-intake.test.ts` | 57 | V1–V6 verification and byte preservation; R1–R4 window/replay; M1–M5 malformed, invalid UTF-8, 413, 64 KiB default, 415; T1–T5 timeouts, 5xx/4xx/malformed/network, token failure, no poisoning, concurrency cap; D1–D6 dedup and poisoning; P1–P4 real `SQLITE_BUSY` at both writes, rollback, handler exception; S1–S3 PII, correlation id, audit |
| `tests/gate1b-processing.test.ts` | 17 | W1–W9 ownership and agreement; O1–O5 out-of-order, DENIED vs COMPLETED, backoff, max attempts (gaps 5 s, 10 s, 20 s), stale lease; X1 restart recovery |
| `tests/gate1b-route-isolation.test.ts` | 54 | I1–I9 on a real TCP socket; S1 static import scan; S2/S3 config and startup refusals |
| `tests/gate1b-postback-verifier.test.ts` | 40 | B1 exact postback body; B2 mode mapping; B3 deadline when the transport ignores abort; B4 no synthetic SUCCESS; H1–H3 header rules; E1–E3 minimisation; C1–C3 config |
| `tests/gate1b-processes.test.ts` | 2 | K1/K2: real OS processes killed with SIGKILL (§8) |

Mutation results (each killed by the tests named):

| Mutation | Killed by |
|---|---|
| M1 postback FAILURE accepted | 8 tests (V2, V3…) |
| M2 200 on persist failure | P2, P3 |
| M3 event-row trigger drops the verified-delivery guard | D5 |
| M4 transmission-age window removed | R1, R4 |
| M5 cert-URL allowlist always true | 13 tests (H1…) |
| M6 agreement check skipped | W4 ×3 |
| M7 forged custom_id not caught before readback | W3 |
| M8 ownership check skipped | W1, X1 |
| M9 max-attempts cap removed | O4 |
| M10 exact request-target hook removed | I5 ×4 (`%70aypal`, `?x=1`, `#frag`, absolute-form) |
| M11 PayPal 5xx treated as definitive FAILURE | 9 tests (T1, T2…) |

## 4. Signature-verification behaviour

- **Method: postback only.** The official docs (developer.paypal.com, read 2026-10-18) describe two methods: postback to `verify-webhook-signature`, and self-verification (CRC32 of the raw body plus an RSA check against a downloaded certificate).
  - OrderTruth uses **postback**: PayPal checks the signature and fetches its own certificate, so no certificate is ever downloaded from an attacker-supplied header.
  - Self-verification is **not implemented**. It would need certificate fetching, pinning and caching, which this gate was told to avoid.
- **Request body** follows the schema (`/docs/api/webhooks/v1/schema.json`), with all 7 fields required: `auth_algo`, `cert_url`, `transmission_id`, `transmission_sig`, `transmission_time`, `webhook_id` and `webhook_event`.
  - The event is embedded **as received**. The docs warn that re-serialising it can fail verification.
  - B1 asserts the exact bytes, including escapes such as `é` and `\/` that `JSON.stringify` would rewrite.
- **Headers:** each of `paypal-transmission-id`, `-time`, `-sig`, `paypal-cert-url` and `paypal-auth-algo` must appear exactly once. Repeated headers are rejected.
  - Id, signature and webhook id are pattern- and length-checked against the schema.
  - The only accepted algorithm is `SHA256withRSA`.
- **Response mapping:**

  | Outcome | Response |
  |---|---|
  | `SUCCESS` | accepted (200) |
  | `FAILURE` | `400 signature_invalid` (rejected) |
  | Timeout, network, PayPal 4xx/5xx, OAuth failure, missing or odd `verification_status` | `503 verification_unavailable` (retryable_failure) |
  | Verifier busy | 503 |

  A 2xx from PayPal without `verification_status` is never treated as success (B4).
- **Credentials** (client id/secret, OAuth token, webhook id) stay in the server process. They are not logged (redaction set includes the webhook id) and are never returned to the caller.
- **Simulator events** carry webhook id `WEBHOOK_ID`. The docs say postback is not supported for them, so the simulator **cannot** be used to test this listener. Config refuses that id.

## 5. Durable acknowledgement and retry

| Step | Durable state | Response if it fails |
|---|---|---|
| Delivery row inserted (`received_unverified`) | Delivery recorded (body SHA-256 and size, claimed id/type as hints) | `503 inbox_unavailable`. Nothing is claimed. |
| Structure / headers / window | Delivery → `rejected` with reason | 400 |
| Postback | Delivery → `rejected` (FAILURE) or `retryable_failure` (unavailable) | 400 / 503 |
| One transaction: delivery → `verified` or `duplicate`, event row (`verified_pending`), evidence `PAYPAL_VERIFIED_WEBHOOK` | Event durable | `503 persist_failed`, full rollback (P3) |
| 200 `{ok:true, result:"accepted"\|"duplicate"}` | | |

- **Processing** happens after the 2xx. A durable event cannot be lost by a crash; it is reclaimed when its lease expires (K2, X1).
- **Event states:** `verified_pending → processing → processed | disagreed | foreign | ignored | retryable_failure → … | failed`.
- **Retry backoff** is `min(5 s·2^(n−1), 10 min)`. An event goes to `failed` after 10 attempts.
- PayPal's own retries (up to 25 over 3 days, per the docs) cover the non-2xx cases.
- **Mapping the requested states:**
  - received-unverified = `received_unverified`
  - verified-pending = `verified_pending`
  - processed = `processed`
  - rejected/foreign = `rejected` (delivery), `foreign` / `disagreed` (event)
  - retryable failure = `retryable_failure` (both tables)
  
  Two further states exist: `abandoned` (a delivery open at a crash) and `ignored` (an unhandled event type).

## 6. Duplicates and reordering

- Dedup is by PayPal event id, inside the accept transaction.
  - A second verified delivery of the same id is recorded as delivery `duplicate`, and no second event row is created.
  - This holds for 20 concurrent deliveries (D2) and for two separate SQLite connections (D3).
  - Redelivery after a crash: K1 and K2 both end with `duplicate`.
- Unverified deliveries cannot claim an id (D4, D5).
- Reordering: an event never sets state. State follows the authoritative readback, and Gate 1A transitions never go backwards.
  - A late PENDING or APPROVED after COMPLETED leaves the order `captured` (O1).
  - DENIED cannot override a COMPLETED readback (O2).
  - APPROVED while PayPal says CREATED leaves the attempt unapproved (W7).
- Webhook processing never issues a capture POST. Settling an `uncertain` attempt through a webhook costs 0 capture POSTs (W5, K2).

## 7. Route isolation results (real TCP sockets)

| Check | Result |
|---|---|
| Bound address | `127.0.0.1` only; port ≠ the main app's (I1). Listener refuses `0.0.0.0` and `port === PORT` (S2). |
| Registered routes | exactly 1: `/webhooks/paypal (POST)` (I2) |
| GET/HEAD/PUT/PATCH/DELETE/OPTIONS/TRACE | 404, nothing recorded (I4) |
| CONNECT | socket closed with no response (Node has no CONNECT handler), nothing recorded |
| 33 POST target variants | all exactly 404, nothing recorded (I5). Includes checkout/capture/readback APIs, `/`, static assets, admin/debug/metrics/docs, trailing slash, case variants, `//`, `./`, `../`, `%70`, `%2F`, query, fragment, `;param`, `%00`, absolute-form URLs to 3001/3002, and `*`. |
| Method-override / URL-rewrite headers | 404 (I6) |
| Spoofed `Host` / `X-Forwarded-*` / `Forwarded` pointing at the checkout app | 404, and the checkout app's request counter stayed at 0 (I7) |
| Checkout app has no webhook route | 404 (I8) |
| Listener's outbound origin | only `https://api-m.sandbox.paypal.com` (I9) |
| Static scan of `src/webhooks/*` | no import of `../server/`, `@fastify/static`, proxy or reply-from, `node:http(s)`, `fetch(` or `child_process` (S1) |

## 8. Migration and restart checks

**Process-kill tests:** real OS processes, shared SQLite file, HTTP-served fake.

- **K1:** the process is SIGKILLed after PayPal SUCCESS and before the commit.
  - Result: no ack (connection dropped), delivery left `received_unverified`, no event row.
  - Restart: `abandoned = 1`, then a redelivery is accepted, then a further redelivery is a `duplicate`.
- **K2:** the process is SIGKILLed after the commit, just before the readback GET.
  - Result: event `processing`, attempt `uncertain`.
  - Restart: the lease is reclaimed (`process_attempts = 2`), the event is `processed` and the attempt is `captured`, with **0 additional capture POSTs**. A redelivery is a `duplicate`.
- **Flakiness:** 3 consecutive runs, all 2/2 pass (`.work/runs/gate1b/06-processes-x3.txt`).

**Migration** (`04-migration.txt`):

1. **Backup:** `VACUUM INTO` of `.work/ordertruth.sqlite` → `.work/backups/ordertruth.pre-gate1b.20261018T185742Z.sqlite` (integrity ok), plus a raw byte copy.
   - Before the backup there was no `-wal`/`-shm`, and the source SHA-256 was unchanged by it.
2. **Rehearsal on a scratch copy:** versions `[1] → [1,2,3]`. The `.work` DB had never been opened by Gate 1A code, so **migration 2 (Gate 1A) and migration 3 (Gate 1B) were both applied here.**
   - Integrity ok, 0 FK violations.
   - States preserved: 8 `awaiting_buyer_approval`, 1 `captured`.
   - 25 evidence rows preserved (15 `PAYPAL_API_READBACK`, 10 `PAYPAL_API_RESPONSE`).
   - New webhook tables empty; 13 transition rows.
   - A re-open is idempotent.
   - The schema is identical to a freshly created v3 DB (35 objects, same SQL).
3. **Real DB:** the precondition was no OrderTruth process running and a 0-byte WAL. The real file's SHA-256 equalled the raw backup (`db5890d0…`).
   - The migration gave the same results as the rehearsal, and the schema is identical to a fresh v3 DB.
   - **The real `.work/ordertruth.sqlite` is now at schema v3.** Rollback: restore the backup file while no process is running.

## 9. Secret scan and cost

- **Scan:** `.work/scripts/secret-scan.cjs` scanned 68 files (src, tests, docs, package.json, `.env.example`, README/AGENTS/CLAUDE, Gate 1B logs, scripts).
  - It loads `.env` in-process and prints counts only. Values are never printed.
  - It now also checks the `PAYPAL_WEBHOOK_ID` value.
  - Result: **0 real secret values** (client secret, AI key, webhook id), and the client id appears in 0 files.
  - 3 pattern hits, all deliberate fake tokens already present in HEAD `db61aa5` (Gate 1A fake-token and redaction fixtures). Gate 1B introduced 0.
- **Cost:** ₹0.
  - 0 PayPal Sandbox calls and 0 Gemini calls during Gate 1B.
  - No new dependency, no Docker, Redis or paid service. No tunnel tool installed.

## 10. MOCKED vs VERIFIED-LIVE

| Claim | Status |
|---|---|
| Listener surface, isolation, size/content-type limits, durable ack, dedup, crash recovery, DB triggers | VERIFIED-LOCAL (real sockets, real SQLite, real process kills) |
| Postback request shape matches the documented schema | VERIFIED-LOCAL against docs; **NOT TESTED live** |
| PayPal returns `SUCCESS` for a genuine Sandbox delivery to this code | **NOT TESTED** (MOCKED: fake HMAC signer) |
| Real deliveries carry `PAYPAL-AUTH-ALGO` = `SHA256withRSA` | Documented in the webhooks v1 schema field descriptions (recheck 2026-10-19, `docs/GATE1B_LIVE_PREFLIGHT.md` §5). Presence on real deliveries: **NOT TESTED**. If the header is absent, every delivery is rejected 400 (fail closed, not unsafe). |
| Real cert URLs fall within the allowlist (`api(-m).sandbox.paypal.com/v1/notifications/certs/…`) | **HYPOTHESIS** |
| PayPal retries carry a fresh `transmission_time` | **HYPOTHESIS** (§11 risk 1) |
| Real event `resource` shapes match the summary extractor (capture `supplementary_data.related_ids.order_id`, `custom_id`) | **HYPOTHESIS** from the docs examples |
| Postback latency within 5 s | **NOT TESTED** |

## 11. Remaining risks

1. **Transmission window vs PayPal retries.**
   - If PayPal retries reuse the original `transmission_time`, a delivery we answered with 503 is rejected as `transmission_expired` once it is older than 1 h. The event would then be lost to webhooks.
   - Payment state is still covered by the Gate 1A readback reconciler, which does not depend on webhooks.
   - Mitigation options: confirm live behaviour, raise `WEBHOOK_MAX_TRANSMISSION_AGE_MS` (configurable up to 4 days), or use PayPal's resend API.
2. **`paypal-auth-algo` header requirement:** see §10. Check this on the first live delivery.
3. **Postback dependency.** If PayPal's verify endpoint is down, every delivery gets 503 and is retried by PayPal. No event is accepted on our own judgement. This is safe but adds latency.
4. **Unbounded growth: MITIGATED (VERIFIED-LOCAL).** There is now a pre-persistence token bucket (429), a durable ceiling on stored non-verified rows (503) and a keep-all retention policy with a proposed pruning rule. See `docs/GATE1B_LIVE_PREFLIGHT.md` §1–2. Residual risk: someone who knows the tunnel URL can delay genuine deliveries, but cannot forge events.
5. **Single host, single SQLite file.** Multi-instance correctness is not certified (D6).
6. **Self-verification not implemented.** Simulator events cannot be verified (by design).
7. **Narrow agreement predicate.** It compares id, single unit, custom_id, capture id and amount. Partial refunds, multiple captures and disputes are not handled (they are `ignored` by type).
8. **Node `node:sqlite` is experimental** in Node 22.18 (unchanged from Gate 0/1A).

## 12. Questions needed before the tunnel (not blocking this review)

1. Which tunnel tool, if any, is acceptable at ₹0 (none is installed; ledger at Gate 0)? It must forward to `127.0.0.1:3002/webhooks/paypal` only.
2. Should we keep the 1 h transmission window for the first live test, or widen it (§11 risk 1)?
3. Which event types should the Sandbox webhook subscribe to? I suggest only `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED` and `CHECKOUT.ORDER.APPROVED`.

## 13. Stage 1B tunnel activation checklist (for your approval; do NOT run yet)

1. User approves the tunnel tool and this report. Claude does nothing external before that.
2. Run `pnpm typecheck && pnpm test`: 258/258 on the reviewed tree.
3. Back up `.work/ordertruth.sqlite` again, with no process running.
4. Start the tunnel pointed **only** at `http://127.0.0.1:3002`. Never at 3001.
5. In the Sandbox app, register the webhook URL `https://<tunnel>/webhooks/paypal` with the event types from §12.3. **User action.** Record the issued webhook id.
6. User sets `PAYPAL_WEBHOOK_ID=<id>` in `.env` locally. Claude never reads it.
7. Start the listener: `pnpm webhooks`. Confirm it binds `127.0.0.1:3002` and refuses to start without the id.
8. From outside, through the tunnel:
   - `GET /`, `POST /api/orders` and `GET /webhooks/paypal` → 404.
   - The checkout app on 3001 logs zero requests.
9. Do one Sandbox capture with explicit user approval (Stage 1C scope) and observe:
   - Delivery `verified`, PayPal postback `SUCCESS`, event `processed` by readback.
   - Whether the `paypal-auth-algo` header is present, and the cert-URL host.
   - Postback latency.
10. Use PayPal's resend for the same event → `duplicate`. Record whether `transmission_time` changes (§11 risk 1).
11. Send a forged POST with invalid signature headers through the tunnel → 400. Check that no event row is created.
12. Stop the tunnel and the listener. Then: secret scan, sanitized evidence, matrix update.

## 14. Git

Read-only `git status` / `git diff --stat` only. Modified: `.env.example`, `package.json`, `src/checkout-service.ts`, `src/config.ts`, `src/db/store.ts`, `src/paypal/client.ts`, `tests/fake-paypal.ts`. New: `src/webhooks/` (8 files), 5 test files, 2 test helpers, this document, and a matrix update. **CLAUDE MADE NO GIT COMMITS.**
