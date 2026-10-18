# OrderTruth — Gate 0 Handoff and Gate 1 Proposal (for independent review)

**Date:** 2026-10-18 · **Author:** Claude Code (Opus 5.5) · **Status:** Gate 0 accepted by user. Gate 1 is **proposed, not started**. No Gate 1 code has been written.

**CLAUDE: ZERO GIT WRITES / ZERO COMMITS.** No capture was performed for this handoff (readback and status calls only; the last money-moving call was capture `5YV23435BN640024J` during Gate 0). Budget ₹0. Sandbox only.

Companion: [`GATE0_FEASIBILITY_REPORT.md`](GATE0_FEASIBILITY_REPORT.md) (complete Gate 0 report). Appendices A–C below hold the sanitized evidence manifest, the source inventory and per-test results.

---

## 0. Decision packet

| # | Decision requested | Recommendation | Why it is yours |
|---|---|---|---|
| D1 | Allow a **free HTTPS tunnel** for webhook intake (e.g. Cloudflare quick tunnel: no account, ₹0, random URL per run) | Approve, local-only, Gate 1 only | Tunnels are currently disallowed; PayPal cannot reach `127.0.0.1`. Without one, "real webhook intake" is impossible at ₹0 without a deploy (also disallowed). |
| D2 | You create a **Sandbox webhook** on the REST app in the dashboard and put its ID in `.env` (`PAYPAL_WEBHOOK_ID`) | Approve | Dashboard action on your account; Claude never handles the value. |
| D3 | Allow up to **3 new Sandbox captures** (USD 1.00 each) during Gate 1, each approved by you with the **US** personal buyer | Approve with cap 3 | Every capture moves (Sandbox) money and needs your explicit go-ahead. |
| D4 | Make **Gate 1 step 0** fixing the capture-recovery findings in §1 (F1–F3) before any new feature | Approve | Changes Gate 0 code that you have committed. |
| D5 | Add a **reference-merchant module** (merchant orders and fulfillment) with a test-only, logged fault-injection switch | Approve | New architecture surface; this is what repairs act on. |
| D6 | Confirm ADR-002, ADR-003, ADR-004 (currently *Proposed*) | Confirm | Product-owner decision. |

The full vertical slice is defined in §3–§4. Implementation starts only after D1–D6 are answered.

---

## 1. Capture safety: local deduplication vs. recovery after PayPal succeeds

These are **different problems**. Gate 0 proved the first one live. The second one is only partly handled, and is not tested.

### 1a. Local capture deduplication (preventing a second capture call) — VERIFIED

| Layer | Mechanism | Scope | Evidence |
|---|---|---|---|
| L1 | `#inFlight` map: concurrent calls for one order share one promise | one process only | MOCKED test "concurrent captures result in exactly one provider capture" |
| L2 | Terminal short-circuit: `captured`/`denied`/`mismatch` returns stored result, no PayPal call | all processes (DB) | **Live:** repeat capture of `7PR849237P132474B` made 0 PayPal calls (`.work/runs/05-duplicate-capture.json`) |
| L3 | Pre-capture GET readback: existing capture ⇒ reconcile instead of capture; status ≠ APPROVED ⇒ 409 | all processes | Live pre-capture readback APPROVED (`…_0022_…`); MOCKED "refuses to capture before buyer approval" |
| L4 | `claimCapture` compare-and-set to `capture_in_progress` | all processes sharing the DB | MOCKED "claimCapture is compare-and-set" |
| L5 | Stable `PayPal-Request-Id` (`ot-capture-<attemptId>`) stored at intent creation | provider side | Live header sent (`…_0023_…`); PayPal's replay behaviour **NOT_TESTED live** (only the mock honours it) |

### 1b. Recovery when PayPal succeeds but our write fails — PARTIAL, NOT TESTED

**Failure point.** In `src/checkout-service.ts:225-231`, after `captureOrder` returns 201, the next step is `#callEvidence` → `store.appendEvidence` and `writeFileSync`. If either throws (SQLITE_BUSY after the 5 s busy_timeout, disk full, file lock, or a process crash):
- the error is not a `PayPalError`, so it is rethrown (line 228);
- the post-capture readback is skipped;
- the attempt stays **`capture_in_progress`** with `capture_id = NULL`;
- the browser gets HTTP 500;
- **PayPal has captured the money.**

| Finding | What happens | Severity | Status |
|---|---|---|---|
| **F1** Stuck `capture_in_progress` | Recovery works only if someone calls `capture` again (the pre-capture readback finds the capture and reconciles) or calls `readback`. There is **no automatic sweeper**, and nothing alerts. | High | HYPOTHESIS from reading the code: no DB-fault-injection test exists. The existing "5xx after apply" test covers the *provider* failing after applying, not *our DB* failing. |
| **F2** Buyer retries after an error ⇒ **second real charge** | Every `POST /api/orders` creates a new intent, attempt and request ID. A buyer who sees the 500 and clicks Pay again gets a second, independent order and capture. L1–L5 do not help, because they are scoped per attempt, not per checkout. | **High** | HYPOTHESIS from reading the code; untested. |
| **F3** Cross-process race overwrites the claim | `checkout-service.ts:219` writes `state='approved'` **without** compare-and-set. Process B's pre-capture readback can run while process A holds `capture_in_progress` and the provider has not applied the capture yet. B then resets the state to `approved`, wins `claimCapture`, and sends a second capture POST. Only L5 (same `PayPal-Request-Id`) stands between that and a second capture. Single-process deployments are protected by L1. | Medium | HYPOTHESIS from reading the code; no multi-instance test. |
| F4 | Evidence file and DB evidence row are not atomic (file written after the row). A crash between them gives a DB row with no file. | Low | Code reading |
| F5 | The terminal short-circuit has no dedicated test; it is masked by L3 (found by mutation). | Low | VERIFIED by mutation |

**Proposed fix (Gate 1 step 0, needs D4):**
- Make line 219 a compare-and-set only from `awaiting_buyer_approval|uncertain`, and never overwrite `capture_in_progress`.
- Add a checkout-intent idempotency key from the browser (one *captured* attempt per intent), so a retry returns the existing order.
- Add a reconciler that runs at startup and on an interval. For `capture_in_progress` or `uncertain` older than N seconds, it does a **readback only, never a capture**.
- Wrap DB writes after a provider success so a failure lands in `uncertain` with a reason. The capture then goes through the readback path rather than leaving a bare 500.
- Tests G1-R01…R07 in §4.

---

## 2. Remaining risk register

**Reliability**
- R1–R2 = F1, F2 above.
- R3: abandoned orders never expire; 8 Sandbox attempts sit in `awaiting_buyer_approval`.
- R4: the PayPal-Request-Id retention window is limited per PayPal docs; the exact value was not verified. Late retries must rely on readback, which the code already does.
- R5: OAuth token refresh on a mid-session 401 is not tested live.
- R6: Sandbox availability is outside our control. One generic-error class was seen in Gate 0 (IN→IN; see report §5).

**Concurrency**
- C1 = F3.
- C2: `#inFlight` is per process.
- C3: SQLite single writer and `busy_timeout` 5 s. Under contention a write can fail after a provider success, which leads back to F1.
- C4: `node:sqlite` is experimental on Node 22.

**Webhooks** (nothing implemented)
- W1: no endpoint, no signature verification, `PAYPAL_WEBHOOK_ID` empty, no tunnel.
- W2: a quick-tunnel URL changes every run, so the dashboard webhook must be re-registered each session. A stable URL needs an account and domain, or a deploy.
- W3: PayPal delivers webhooks at-least-once, possibly out of order, delayed, and retried for an extended period. Dedup must be per event ID, and processing must be idempotent.
- W4 (HYPOTHESIS): the dashboard *simulator* events may not pass `verify-webhook-signature`. Use real events from real Sandbox captures for acceptance.
- W5: verification is a PayPal API call. If it times out, the event must be stored as **unverified** and must never change merchant state.

**AI evaluation**
- A1: n = 10 calls over 8 synthetic scenarios, with labels that equal the baseline by construction. There is no held-out set and no real incident data, so 10/10 agreement does not show generalization.
- A2: the money-movement detector is a regex and produced one false positive (S5).
- A3: the quota numbers (15 RPM / 500 RPD) are reported by the user, and the remaining-quota figure is an estimate.
- A4: model drift. The model ID is pinned; re-run the eval whenever it changes.
- A5: repeatability was checked on only 2 pairs.
- A6: the AI is advisory only. If it is disabled, the slice must still work deterministically.

**Clean clone** (VERIFIED at HEAD `7bb4a69` via `git archive` into a scratch directory, no `.env`)
- Export contained 45 files.
- `pnpm install --frozen-lockfile` 0, `typecheck` 0, `test` 68/68 (0), `build:web` 0.
- `start` exits **2** with "Configuration error (keys: PAYPAL_ENV, PAYPAL_API_BASE, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET)". Only key names are shown, no values.
- Remaining risks:
  - K1: verified only on Windows with Node 22.18 and pnpm 11.4. Linux/macOS are NOT_TESTED, and `engines` rejects Node ≥ 23.
  - K2: pnpm 11 requires the `allowBuilds: esbuild` entry.
  - K3: on Windows, stopping a background shell task leaves the Node child running; use `taskkill /T`.
  - K4: this handoff and the feasibility report are not yet committed.
  - K5: two duplicate root docs (byte-identical) are kept by instruction.

**Security / ops**
- S1: the API has no authentication. It is bound to `127.0.0.1` only. The capture endpoint takes no body, so another local page could trigger a capture of an *already-approved* order (Low; it cannot capture without buyer approval). Gate 1 adds an Origin check and a CSRF token.
- S2: the operator UI (Gate 1) will need role separation between the engineer and merchant-operator views (ADR-001).

---

## 3. Gate 1 proposal — one end-to-end vertical slice

**Slice:** *"A real Sandbox payment produces a duplicate merchant order. OrderTruth detects it from verified provider truth, investigates it, a human approves a repair, and the outcome is verified."* It is one path, built end to end, with no breadth.

```
buyer approves (US Sandbox buyer, manual)
  → server capture (Gate 0 path + F1–F3 fixes)
  → PayPal webhook PAYMENT.CAPTURE.COMPLETED ──tunnel──▶ POST /webhooks/paypal
        verify-webhook-signature (Sandbox API) → store raw event (redacted) → dedupe by event id → 200
  → reference merchant creates merchant order from BOTH browser-return and webhook handlers
        (test-only fault switch removes the unique guard ⇒ duplicate; logged as CONTROLLED_FAULT_INJECTION)
  → consistency checker (deterministic rules = authority) compares PAYPAL_API_READBACK / VERIFIED_WEBHOOK vs MERCHANT_DB
        → incident DUPLICATE_MERCHANT_ORDER with linked evidence
  → investigation: baseline verdict + optional Gemini hypothesis (AI_HYPOTHESIS, advisory, schema-validated)
  → repair plan (deterministic): cancel duplicate merchant order MO-n in the reference merchant DB only; no PayPal writes
  → human approval: single-use token bound to plan hash + incident version
  → execute repair → re-run checker + fresh PayPal readback
  → incident RESOLVED only if all invariants (§4c) hold; otherwise REOPENED with reason
```

**Modules (modular monolith, same stack, no new infrastructure):**
- `webhooks/` (intake, verification, event store)
- `merchant/` (reference merchant tables and handlers)
- `incidents/` (checker, incident store, state machine)
- `repair/` (plan, approval, execute, verify)
- `ai/` (existing adapter, wired to incidents)
- one vanilla-TS operator page

**Not in Gate 1:** refunds or any PayPal money movement during repair, multiple products or currencies, production, Docker, React, dashboards beyond the single operator page, any deploy.

---

## 4. Acceptance definition (fixed before implementation)

### 4a. Tests that must pass

**MOCKED / offline (CI, no network)**

| ID | Test |
|---|---|
| G1-R01 | DB write throws after provider capture 201 ⇒ attempt ends `uncertain` (not stuck), no second capture POST; reconciler readback ⇒ `captured` |
| G1-R02 | Process "crash" after claim, before POST (state `capture_in_progress`, provider APPROVED) ⇒ reconciler never captures; explicit retry captures once with same request id |
| G1-R03 | Two `CheckoutService` instances on one SQLite file capture concurrently ⇒ exactly 1 provider capture POST (fails today: F3) |
| G1-R04 | Second `POST /api/orders` with same checkout key ⇒ returns existing order; after capture ⇒ no new order (fails today: F2) |
| G1-R05 | Terminal short-circuit has its own failing-on-mutation test (F5) |
| G1-R06 | Reconciler only ever issues GET to PayPal (asserted via fake call log) |
| G1-R07 | Abandoned `awaiting_buyer_approval` older than TTL ⇒ `expired` after readback confirms not captured |
| G1-W01 | Valid signature (verify API returns SUCCESS) ⇒ event stored verified, 200 |
| G1-W02 | Verify API returns FAILURE ⇒ 400, event stored unverified, **no merchant state change** |
| G1-W03 | Same event id delivered twice ⇒ second is a no-op (200), one merchant effect |
| G1-W04 | Verify API timeout ⇒ stored unverified, retried later, never acted on until verified |
| G1-W05 | CAPTURE.COMPLETED before browser-return handler ⇒ one merchant order total |
| G1-W06 | Event for an order not created by us ⇒ recorded as foreign, no merchant order, no incident spam |
| G1-W07 | Event amount ≠ intent amount ⇒ incident `mismatch`, no merchant order |
| G1-W08 | Body over size limit ⇒ 413; malformed JSON ⇒ 400; missing PayPal transmission headers ⇒ 400 |
| G1-M01 | Unique guard on: browser-return + webhook race ⇒ exactly one merchant order |
| G1-M02 | Fault switch on (test-only, logged as CONTROLLED_FAULT_INJECTION) ⇒ duplicate produced; switch cannot be enabled when `NODE_ENV=production`-like flag or non-sandbox config |
| G1-I01..I06 | Checker classifies: one capture/one order ⇒ HEALTHY; duplicate ⇒ DUPLICATE_MERCHANT_ORDER; none after grace ⇒ MISSING; none within grace ⇒ no incident; pending capture + fulfillment ⇒ FULFILLED_WITHOUT_CAPTURE; no provider evidence ⇒ INSUFFICIENT_EVIDENCE |
| G1-I07 | OPERATOR_STATEMENT and AI_HYPOTHESIS never change the classification |
| G1-P01 | Repair refused without approval token |
| G1-P02 | Approval token single-use; replay ⇒ 409 |
| G1-P03 | Stale plan (incident/merchant state changed after plan) ⇒ execution refused, re-plan required |
| G1-P04 | Repair never calls PayPal write endpoints (fake asserts zero POSTs to `/v2/*` during repair) |
| G1-P05 | AI output cannot create, approve or execute a plan (no code path; asserted) |
| G1-P06 | Repair re-run after success ⇒ no-op |
| G1-V01 | Post-repair: incident RESOLVED only with fresh PAYPAL_API_READBACK + checker HEALTHY; else REOPENED |
| G1-V02 | Restart between approval and execution, and between execution and verification ⇒ converges, no double repair |
| G1-S01 | Secret scan of evidence, logs, DB and bundle: 0 real values (existing scanner, now a test) |
| G1-S02 | Capture/approve endpoints reject cross-origin requests (Origin check + CSRF token) |

**LIVE Sandbox (each capture needs your explicit approval; cap 3)**

| ID | Live acceptance |
|---|---|
| G1-L1 | Real capture ⇒ real `PAYMENT.CAPTURE.COMPLETED` received through tunnel, signature **verified by PayPal API**, deduped, exactly one merchant order (healthy path) |
| G1-L2 | Real capture with fault switch on ⇒ duplicate merchant order ⇒ incident detected ⇒ plan ⇒ your approval ⇒ repair ⇒ fresh readback ⇒ RESOLVED, all evidence in chain |
| G1-L3 | Dashboard "Resend" of the L1 event ⇒ deduped no-op (no capture needed) |
| G1-L4 | Optional third capture reserved only for a re-run if L1/L2 fail for an environmental reason |

### 4b. Invalid and benign cases (must NOT raise incidents or move state)

- **Duplicate webhook delivery** for one event ID is benign (Gate 0 scenario S2).
- **Within the grace period, no merchant order yet** is benign (S7).
- **Order created but buyer never approved** is benign. It expires after the TTL and never becomes an incident.
- **Buyer cancelled** is benign.
- **Webhooks for unrelated event types**, such as `CHECKOUT.ORDER.APPROVED` arriving after capture, are stored and ignored.
- **Invalid inputs** are rejected with no side effects:
  - unverified or forged webhook
  - foreign order ID
  - malformed or oversized body
  - unknown or invalid order ID
  - expired or reused approval token
  - operator note containing instructions (S5/S6)
  - AI output with invented evidence IDs

### 4c. Recovery invariants (checked by tests and by the checker on the live run)

| ID | Invariant |
|---|---|
| I1 | At most one PayPal capture per attempt, and at most one captured attempt per checkout intent. |
| I2 | No capture call unless a pre-capture readback shows APPROVED. |
| I3 | An unknown outcome is resolved by readback, never by a blind retry. Any retry reuses the stored `PayPal-Request-Id`. |
| I4 | Local `captured` is set only from PayPal readback evidence. A webhook alone triggers a readback; it is not trusted by itself. |
| I5 | Every COMPLETED capture ends, after the grace period, with exactly one active merchant order **or** an open incident. Never silence. |
| I6 | Each webhook event ID is processed at most once. Unverified events never change merchant state. |
| I7 | A repair touches only the reference-merchant DB: zero PayPal write calls, one approved plan hash, single use. |
| I8 | AI output is stored only as AI_HYPOTHESIS and never changes state. |
| I9 | Evidence is append-only, and every state transition has a linked evidence row. |
| I10 | After a restart at any point, the reconciler converges without moving money. |
| I11 | Sandbox host only. The production-host block stays; no secrets leave the server. |

### 4d. Stop conditions (stop work and report to you)

1. A production host, live credential or non-Sandbox endpoint is detected anywhere.
2. Any service asks for billing or payment: tunnel, Gemini or hosting. Budget stays ₹0.
3. A second capture is observed for one attempt or one intent, or any capture you did not approve.
4. PayPal signature verification cannot be made to work after 3 bounded attempts. Do **not** fall back to unverified webhooks; report it as BLOCKED.
5. A real secret value is found in evidence, logs, DB, bundle or git.
6. Sandbox has been unavailable for more than 30 min, or the same provider incompatibility repeats.
7. The live-capture cap (3) is reached.
8. Passing a test would require weakening an invariant in §4c.
9. Gemini quota or billing error: disable the AI and continue with the deterministic path; this is a stop only if the slice cannot complete without the AI, which by design it can.
10. Any git write would be needed. That stays with you, Codex or Antigravity.

---

## 5. Constraints carried forward

- ₹0 budget.
- PayPal Sandbox only (`api-m.sandbox.paypal.com`), with the production host hard-blocked.
- The buyer approves manually; Claude never automates PayPal login.
- No captures beyond the approved cap.
- No deploys.
- No git writes by Claude.
- Subagents get no secrets, no live endpoints and no git access.
- Every claim is labelled VERIFIED / MOCKED / OPERATOR / HYPOTHESIS / NOT_TESTED / BLOCKED.

## 6. git status (read-only, at handoff)

```
## main...origin/main
?? docs/GATE0_FEASIBILITY_REPORT.md
?? docs/GATE0_HANDOFF_AND_GATE1_PROPOSAL.md
```

The Gate 0 code and ADR-004 were committed by the user (`41b1fda`…`7bb4a69`). Both documents above are uncommitted, for review.

---

## Appendix A/B — Sanitized evidence manifest and source inventory

Generated by `.work/scripts/manifest.cjs`: file metadata and sha256 prefixes only, no contents. Evidence files live in ignored `.work/` and stay on the author's machine; a reviewer can request specific redacted files.

### Evidence manifest (ignored `.work/`, sha256 prefix 16)

| File | Bytes | sha256[0:16] | Class / op | HTTP | Order |
|---|---|---|---|---|---|
| `.work/metrics/gemini-gate0-gemini-3.5-flash-lite-1792346199707.json` | 14836 | `14b59e2de9449442` |  |  |  |
| `.work/runs/01-oauth.json` | 226 | `f618dfe0bf4dc1fe` |  | 200 |  |
| `.work/runs/01-oauth.stderr.log` | 169 | `5f75a58d083201a6` |  |  |  |
| `.work/runs/02-readback-after-approval.json` | 500 | `31abc316d67ea7bb` |  |  | 22Y35806K4083780E |
| `.work/runs/02.stderr.log` | 380 | `a2ff49ea5e50e3f1` |  |  |  |
| `.work/runs/03-gemini-models.txt` | 1716 | `ea4462ca9f6f6560` |  |  |  |
| `.work/runs/04-gemini-eval.json` | 2680 | `06f1e1858229288c` | (multi-line log) |  |  |
| `.work/runs/04-gemini-eval.stderr.log` | 0 | `e3b0c44298fc1c14` |  |  |  |
| `.work/runs/05-duplicate-capture.json` | 482 | `b32dcda096e6d289` |  |  | 7PR849237P132474B |
| `.work/runs/06-restart-status.json` | 328 | `02e7010c046c17a2` |  |  | 7PR849237P132474B |
| `.work/runs/07-db-check.json` | 2837 | `c4f9682f2bd7a5c6` |  |  |  |
| `.work/runs/08-install.err` | 0 | `e3b0c44298fc1c14` |  |  |  |
| `.work/runs/gate0/2026-10-18T17-52-18-067Z_0001_create_order.json` | 995 | `b3a76024631a0e7c` | PAYPAL_API_RESPONSE / create_order | 201 | 22Y35806K4083780E |
| `.work/runs/gate0/2026-10-18T17-52-44-857Z_0002_readback.json` | 943 | `745aabdd127e9aec` | PAYPAL_API_READBACK / readback | 200 | 22Y35806K4083780E |
| `.work/runs/gate0/2026-10-18T17-53-50-054Z_0003_create_order.json` | 996 | `5c8565f2df842213` | PAYPAL_API_RESPONSE / create_order | 201 | 7P184509NJ4745838 |
| `.work/runs/gate0/2026-10-18T17-56-38-394Z_0004_create_order.json` | 996 | `deadedb777f795d5` | PAYPAL_API_RESPONSE / create_order | 201 | 4HN12872PC5869459 |
| `.work/runs/gate0/2026-10-18T17-58-02-260Z_0005_readback.json` | 944 | `e3694efb0c582145` | PAYPAL_API_READBACK / readback | 200 | 22Y35806K4083780E |
| `.work/runs/gate0/2026-10-18T17-58-06-045Z_0006_readback.json` | 944 | `3743a4c8bbe3fddb` | PAYPAL_API_READBACK / readback | 200 | 7P184509NJ4745838 |
| `.work/runs/gate0/2026-10-18T17-58-09-792Z_0007_readback.json` | 943 | `1b5b25cfc23fcc0f` | PAYPAL_API_READBACK / readback | 200 | 4HN12872PC5869459 |
| `.work/runs/gate0/2026-10-18T17-58-18-606Z_0008_readback.json` | 944 | `f9722ee2244141af` | PAYPAL_API_READBACK / readback | 200 | 22Y35806K4083780E |
| `.work/runs/gate0/2026-10-18T17-58-22-564Z_0009_readback.json` | 944 | `17379573b11c2440` | PAYPAL_API_READBACK / readback | 200 | 7P184509NJ4745838 |
| `.work/runs/gate0/2026-10-18T17-58-26-354Z_0010_readback.json` | 945 | `2f6ca3a0b2bb95b3` | PAYPAL_API_READBACK / readback | 200 | 4HN12872PC5869459 |
| `.work/runs/gate0/2026-10-18T17-58-32-028Z_0011_create_order.json` | 997 | `ce3aa89c46aa52fa` | PAYPAL_API_RESPONSE / create_order | 201 | 35C368532G4267628 |
| `.work/runs/gate0/2026-10-18T17-58-33-365Z_0012_readback.json` | 944 | `17b29e6371da1176` | PAYPAL_API_READBACK / readback | 200 | 4HN12872PC5869459 |
| `.work/runs/gate0/2026-10-18T17-58-43-574Z_0013_readback.json` | 945 | `90c5fa5f7dc56616` | PAYPAL_API_READBACK / readback | 200 | 22Y35806K4083780E |
| `.work/runs/gate0/2026-10-18T17-58-47-198Z_0014_readback.json` | 945 | `ff8fcb305e502d1c` | PAYPAL_API_READBACK / readback | 200 | 7P184509NJ4745838 |
| `.work/runs/gate0/2026-10-18T17-59-36-398Z_0015_create_order.json` | 964 | `d71f6e1165cab11d` | PAYPAL_API_RESPONSE / create_order | 200 | 4KH90953EG8007103 |
| `.work/runs/gate0/2026-10-18T17-59-56-076Z_0016_create_order.json` | 997 | `f13d98c612c18e61` | PAYPAL_API_RESPONSE / create_order | 201 | 9DR7190961124815W |
| `.work/runs/gate0/2026-10-18T18-00-41-336Z_0017_create_order.json` | 997 | `22e2ffa53dc62b2b` | PAYPAL_API_RESPONSE / create_order | 201 | 63464824UF040311U |
| `.work/runs/gate0/2026-10-18T18-01-29-925Z_0018_create_order.json` | 997 | `b023c2360532c3c1` | PAYPAL_API_RESPONSE / create_order | 201 | 6JD62289HJ713871H |
| `.work/runs/gate0/2026-10-18T18-02-26-888Z_0019_readback.json` | 931 | `8fdfe13ba861c2bc` | PAYPAL_API_READBACK / readback | 200 | 4KH90953EG8007103 |
| `.work/runs/gate0/2026-10-18T18-02-31-132Z_0020_readback.json` | 945 | `7fcc5bbcce7320c1` | PAYPAL_API_READBACK / readback | 200 | 6JD62289HJ713871H |
| `.work/runs/gate0/2026-10-18T18-05-02-595Z_0021_create_order.json` | 997 | `9ad0f6121cb29534` | PAYPAL_API_RESPONSE / create_order | 201 | 7PR849237P132474B |
| `.work/runs/gate0/2026-10-18T18-05-30-761Z_0022_pre_capture_readback.json` | 942 | `0b47619502a7cb6e` | PAYPAL_API_READBACK / pre_capture_readback | 200 | 7PR849237P132474B |
| `.work/runs/gate0/2026-10-18T18-05-31-968Z_0023_capture_order.json` | 1252 | `70f2d3add16eed74` | PAYPAL_API_RESPONSE / capture_order | 201 | 7PR849237P132474B |
| `.work/runs/gate0/2026-10-18T18-05-32-525Z_0024_post_capture_readback.json` | 1211 | `497f3759e27ec37f` | PAYPAL_API_READBACK / post_capture_readback | 200 | 7PR849237P132474B |
| `.work/runs/gate0/2026-10-18T18-06-09-107Z_0025_readback.json` | 1197 | `430d1d37cd1cd87b` | PAYPAL_API_READBACK / readback | 200 | 7PR849237P132474B |
| `.work/runs/server.stderr.log` | 2580 | `dbdb8cc3e9dea569` |  |  |  |
| `.work/runs/server.stdout.log` | 27819 | `0de635561d20ec64` |  |  |  |
| `.work/runs/server2.stderr.log` | 169 | `a0c08f8ca07eef50` |  |  |  |
| `.work/runs/server2.stdout.log` | 1057 | `490c749edb0e3812` |  |  |  |
| `.work/ordertruth.sqlite` | 69632 | (live DB; WAL) | MERCHANT_DB | | |

### Source inventory (tracked at HEAD)

| File | Lines | sha256[0:16] |
|---|---|---|
| `.env.example` | 19 | `3ad4e66a1cfa43ef` |
| `.gitignore` | 49 | `9274df3af72896f3` |
| `AGENTS.md` | 86 | `d1971c6060578d2c` |
| `CLAUDE.md` | 26 | `f1f62e0cb1a72721` |
| `CLAUDE_CODE_KICKOFF.md` | 80 | `f9b1c2995c58967d` |
| `ORDERTRUTH_MASTER_PLAN.md` | 344 | `c5aa2e5e251551e3` |
| `README_START_HERE.md` | 44 | `8b65b27034190f7e` |
| `agent.md` | 4 | `1c0e30ce60823573` |
| `docs/API_AND_SECURITY.md` | 17 | `b0911ff6b7b1c982` |
| `docs/ARCHITECTURE_DECISIONS.md` | 20 | `170eeef274497469` |
| `docs/ORDERTRUTH_MASTER_PLAN.md` | 344 | `c5aa2e5e251551e3` |
| `docs/QUALITY_GATE_MATRIX.md` | 23 | `dc0dd2d7933dae33` |
| `docs/RELEASE_CHECKLIST.md` | 15 | `162036f6f18822a3` |
| `docs/RESEARCH_REGISTER.md` | 12 | `f8879975f67f5afa` |
| `package.json` | 34 | `f7fea92e546958ad` |
| `pnpm-lock.yaml` | 1653 | `a53fae73cd0b2acd` |
| `pnpm-workspace.yaml` | 4 | `15d8116624de3d6e` |
| `prompts/CLAUDE_CODE_KICKOFF.md` | 80 | `f9b1c2995c58967d` |
| `src/ai/baseline.ts` | 29 | `19d176a9cbcfb2f0` |
| `src/ai/gate0-eval.ts` | 127 | `14a865fd36771c62` |
| `src/ai/gemini.ts` | 147 | `6b4e589c5bc1ede2` |
| `src/ai/scenarios.ts` | 114 | `7a2240d3c3470b0b` |
| `src/checkout-service.ts` | 268 | `35f79c233b04fffc` |
| `src/cli.ts` | 72 | `e6808f8f28758657` |
| `src/config.ts` | 132 | `4536857a26435c79` |
| `src/db/store.ts` | 190 | `372d7bdb8150d69a` |
| `src/domain/checkout.ts` | 121 | `a9b44aa856bedbce` |
| `src/domain/money.ts` | 23 | `339344a71d29d46f` |
| `src/paypal/client.ts` | 198 | `51fd2ac360d3cf35` |
| `src/paypal/summaries.ts` | 32 | `a9a3fd0b18dde296` |
| `src/redact.ts` | 50 | `2a4dc8c1581a3f5c` |
| `src/runtime.ts` | 23 | `1bb5ae2fc61e7168` |
| `src/server/app.ts` | 72 | `259f59fbe455af0b` |
| `src/server/main.ts` | 23 | `8a8d9286dd6e40b1` |
| `tests/ai.test.ts` | 83 | `0c85f159dcb408e9` |
| `tests/checkout-service.test.ts` | 190 | `397f458e71aff1eb` |
| `tests/config.test.ts` | 60 | `f3ce5706e2c436fe` |
| `tests/fake-paypal.ts` | 136 | `b4b932259f71e41f` |
| `tests/redact-money-verify.test.ts` | 72 | `10e9c512bfb1654a` |
| `tests/store-and-server.test.ts` | 122 | `2d99ca08b3ac7680` |
| `tsconfig.json` | 22 | `d4f2b15fe9510114` |
| `vite.config.ts` | 8 | `e48e2b397636601d` |
| `vitest.config.ts` | 11 | `72aca507bd5ee3f5` |
| `web/index.html` | 26 | `63a58040def4a9c3` |
| `web/main.ts` | 102 | `ae5c5783749e9cf2` |

## Appendix C — Test results (`pnpm vitest run --reporter=verbose`, exit 0; all MOCKED or offline)

```
 ✓ tests/redact-money-verify.test.ts > redaction > removes known secrets, bearer tokens, access_token fields and Google keys
 ✓ tests/redact-money-verify.test.ts > redaction > drops buyer PII and credentials by key in nested objects
 ✓ tests/redact-money-verify.test.ts > redaction > masks identifiers
 ✓ tests/redact-money-verify.test.ts > money > formats integer minor units
 ✓ tests/redact-money-verify.test.ts > money > parses strictly
 ✓ tests/redact-money-verify.test.ts > verifyCaptureReadback (deterministic verdict) > captured only when COMPLETED and amount/currency/id match
 ✓ tests/redact-money-verify.test.ts > verifyCaptureReadback (deterministic verdict) > pending is not captured
 ✓ tests/redact-money-verify.test.ts > verifyCaptureReadback (deterministic verdict) > declined is denied
 ✓ tests/redact-money-verify.test.ts > verifyCaptureReadback (deterministic verdict) > amount mismatch is flagged even if COMPLETED
 ✓ tests/redact-money-verify.test.ts > verifyCaptureReadback (deterministic verdict) > wrong order id is mismatch
 ✓ tests/redact-money-verify.test.ts > verifyCaptureReadback (deterministic verdict) > no capture yet is uncertain, never captured
 ✓ tests/redact-money-verify.test.ts > verifyCaptureReadback (deterministic verdict) > unknown capture status is uncertain
 ✓ tests/config.test.ts > config > accepts a complete sandbox config
 ✓ tests/config.test.ts > config > hard-blocks production host https://api-m.paypal.com
 ✓ tests/config.test.ts > config > hard-blocks production host https://api.paypal.com
 ✓ tests/config.test.ts > config > hard-blocks production host https://api-m.paypal.com/v1
 ✓ tests/config.test.ts > config > rejects any non-sandbox host, even lookalikes
 ✓ tests/config.test.ts > config > rejects PAYPAL_ENV=live
 ✓ tests/config.test.ts > config > reports missing mandatory keys by name, never by value
 ✓ tests/config.test.ts > config > does not leak secret values in error messages
 ✓ tests/config.test.ts > config > requires an API key when gemini is selected (case-insensitive provider)
 ✓ tests/ai.test.ts > rules-only baseline > S1-dup-race -> DUPLICATE_MERCHANT_ORDER
 ✓ tests/ai.test.ts > rules-only baseline > S2-healthy-dup-webhook -> HEALTHY
 ✓ tests/ai.test.ts > rules-only baseline > S3-ship-on-pending -> FULFILLED_WITHOUT_CAPTURE
 ✓ tests/ai.test.ts > rules-only baseline > S4-missing-order -> MISSING_MERCHANT_ORDER
 ✓ tests/ai.test.ts > rules-only baseline > S5-adversarial-operator -> HEALTHY
 ✓ tests/ai.test.ts > rules-only baseline > S6-injection-text -> DUPLICATE_MERCHANT_ORDER
 ✓ tests/ai.test.ts > rules-only baseline > S7-within-grace -> WITHIN_GRACE_PERIOD
 ✓ tests/ai.test.ts > rules-only baseline > S8-empty -> INSUFFICIENT_EVIDENCE
 ✓ tests/ai.test.ts > rules-only baseline > ignores operator statements as facts
 ✓ tests/ai.test.ts > AI output validation > accepts a valid output
 ✓ tests/ai.test.ts > AI output validation > rejects invented evidence ids
 ✓ tests/ai.test.ts > AI output validation > rejects malformed output 0
 ✓ tests/ai.test.ts > AI output validation > rejects malformed output 1
 ✓ tests/ai.test.ts > AI output validation > rejects malformed output 2
 ✓ tests/ai.test.ts > AI output validation > rejects malformed output 3
 ✓ tests/ai.test.ts > AI output validation > rejects malformed output 4
 ✓ tests/ai.test.ts > AI output validation > bounds prompt input
 ✓ tests/ai.test.ts > Gemini adapter failure classification (mocked fetch) > 429 rate limit vs daily quota
 ✓ tests/ai.test.ts > Gemini adapter failure classification (mocked fetch) > billing, 5xx, invalid JSON, empty response
 ✓ tests/ai.test.ts > Gemini adapter failure classification (mocked fetch) > never echoes the API key in error detail
 ✓ tests/ai.test.ts > Gemini adapter failure classification (mocked fetch) > timeout classified
 ✓ tests/ai.test.ts > Gemini adapter failure classification (mocked fetch) > rejects unsafe model ids
 ✓ tests/checkout-service.test.ts > PayPalClient (mocked) > refuses a non-sandbox config at construction
 ✓ tests/checkout-service.test.ts > PayPalClient (mocked) > classifies 401 as auth_failed without leaking secret
 ✓ tests/checkout-service.test.ts > PayPalClient (mocked) > classifies 5xx, timeout and network as outcome-unknown
 ✓ tests/checkout-service.test.ts > PayPalClient (mocked) > only ever calls the sandbox host
 ✓ tests/checkout-service.test.ts > CheckoutService lifecycle (mocked) > creates an order from the server-owned amount and stable request ids
 ✓ tests/checkout-service.test.ts > CheckoutService lifecycle (mocked) > refuses to capture before buyer approval and makes no capture call
 ✓ tests/checkout-service.test.ts > CheckoutService lifecycle (mocked) > captures an approved order, then verifies via GET readback
 ✓ tests/checkout-service.test.ts > CheckoutService lifecycle (mocked) > is idempotent: a second capture makes no provider write
 ✓ tests/checkout-service.test.ts > CheckoutService lifecycle (mocked) > concurrent captures result in exactly one provider capture
 ✓ tests/checkout-service.test.ts > CheckoutService lifecycle (mocked) > 5xx after the provider applied the capture: readback reconciles to captured, no blind retry
 ✓ tests/checkout-service.test.ts > CheckoutService lifecycle (mocked) > timeout on capture with nothing applied: stays approved (safe to retry with same request id)
 ✓ tests/checkout-service.test.ts > CheckoutService lifecycle (mocked) > readback failure after capture leaves state uncertain, not captured and not failed
 ✓ tests/checkout-service.test.ts > CheckoutService lifecycle (mocked) > pending capture is reported as pending
 ✓ tests/checkout-service.test.ts > CheckoutService lifecycle (mocked) > captured amount differing from intent is mismatch
 ✓ tests/checkout-service.test.ts > CheckoutService lifecycle (mocked) > rejects unknown and malformed order ids without provider calls
 ✓ tests/checkout-service.test.ts > CheckoutService lifecycle (mocked) > provider error on create is surfaced and recorded
 ✓ tests/checkout-service.test.ts > CheckoutService lifecycle (mocked) > evidence and logs never contain the secret, token or buyer email
 ✓ tests/store-and-server.test.ts > Store (real SQLite file) > persists intent/attempt/evidence across a separate OS process (restart proof, mocked provider)
 ✓ tests/store-and-server.test.ts > Store (real SQLite file) > evidence is append-only
 ✓ tests/store-and-server.test.ts > Store (real SQLite file) > enforces unique PayPal order id and capture request id
 ✓ tests/store-and-server.test.ts > Store (real SQLite file) > claimCapture is compare-and-set
 ✓ tests/store-and-server.test.ts > HTTP API (mocked provider) > browser config exposes client id only, never the secret
 ✓ tests/store-and-server.test.ts > HTTP API (mocked provider) > ignores browser-submitted amounts
 ✓ tests/store-and-server.test.ts > HTTP API (mocked provider) > propagates a valid correlation id and rejects capture of unapproved order with 409
 ✓ tests/store-and-server.test.ts > HTTP API (mocked provider) > unknown order -> 404; provider 500 on create -> 502 without internals
 Test Files  5 passed (5)
      Tests  68 passed (68)
```
