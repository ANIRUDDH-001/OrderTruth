# OrderTruth — Gate 0 Feasibility Report

**Date:** 2026-10-18 · **Author:** Claude Code (Opus 5.5) · **Scope:** Gate 0 only · **Environment:** PayPal **Sandbox** only (`https://api-m.sandbox.paypal.com`), no real money.

**CLAUDE: ZERO GIT WRITES / ZERO COMMITS.** Git was used read-only (status, log, ls-files, check-ignore). Nothing was staged, committed, pushed, branched or reset.

## Recommendation: **BUILD** (proceed to Gate 1 only after explicit user approval)

The core risk for Gate 0 is now retired. A real Sandbox buyer approved a server-priced order. The server captured it with a stable idempotency key, verified it by PayPal readback, and kept the result in SQLite across process restarts. Gemini returned schema-valid structured output for 10/10 synthetic scenarios within the free tier. Nothing is blocked. The conditions to carry into Gate 1 are listed under [Limitations](#limitations-and-gaps).

### Label legend

| Label | Meaning |
|---|---|
| **VERIFIED** | Observed in this session against the real Sandbox / Gemini API or a real local process, with evidence on disk. |
| **MOCKED** | Proven only against the in-memory fake PayPal (`tests/fake-paypal.ts`) or a mocked `fetch`. **Not** a Sandbox execution. |
| **OPERATOR** | Observed by the user in the PayPal dashboard or browser, reported to Claude (screenshots); not independently checked by API. |
| **HYPOTHESIS** | Plausible explanation, not proven. |
| **NOT_TESTED / GAP** | Out of scope or deferred. |

## 1. Summary of Gate 0 criteria

| # | Criterion | Result | Label |
|---|---|---|---|
| 1 | Sandbox credentials work (OAuth) | HTTP 200 | VERIFIED |
| 2 | REST app belongs to the intended Sandbox business account | Dashboard: business account `sb-c43g…@business.example.com` has Apps = 1, personal has 0 | OPERATOR |
| 3 | Create order with server-owned amount | HTTP 201, USD 1.00 from `GATE0_PRODUCT` (browser body ignored) | VERIFIED |
| 4 | Real buyer approval flow (SDK v6 popup) | Approved by a US personal Sandbox buyer; pre-capture readback = APPROVED | VERIFIED (approval act by user) |
| 5 | Server capture with stable idempotency key | HTTP 201, `PayPal-Request-Id: ot-capture-pa_644e2121-…` | VERIFIED |
| 6 | GET readback; state, amount, currency and IDs match | COMPLETED, USD 1.00, order ID and custom_id match | VERIFIED |
| 7 | Duplicate capture does not move money twice | Second capture made no PayPal call; same capture ID | VERIFIED (live), plus MOCKED concurrency tests |
| 8 | Redacted evidence persisted in SQLite and files | 5 append-only evidence rows for the captured order | VERIFIED |
| 9 | Persistence across app restart | Server PID 37212 killed → new server PID 29644 returned `captured`; CLI PID 24920 agrees | VERIFIED |
| 10 | Config rejects production hosts and missing mandatory values | Unit tests | MOCKED (offline unit tests) |
| 11 | Gemini structured output within free quota | 10/10 schema-valid, 0 invented evidence IDs | VERIFIED |
| 12 | Deterministic rules-only baseline | `src/ai/baseline.ts`, 8 scenario tests | VERIFIED (offline) |
| 13 | Reproducible install/typecheck/test/start | All exit 0 | VERIFIED |
| 14 | Webhooks | Deferred by user | **GAP** |

## 2. Git and secret audit

- **Repo:** branch `main` @ `9b6bdc2`, which matches `origin/main` (`https://github.com/ANIRUDDH-001/OrderTruth.git`), 3 commits. Tracked files: docs, prompts, `.env.example`, `.gitignore`.
- **`.env` / `.work/`:** both confirmed ignored with `git check-ignore`. `.env` was never printed. Its keys were checked by name and set/empty status only.
- **History scan:** value-level scan (`.work/scripts/env-audit.cjs`). The actual `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `AI_API_KEY` values appear in **no commit and no tracked file**. A pattern scan of all commits found 0 hits. **No exposure detected.** VERIFIED.
- **Workspace scan at end of Gate 0:** `.work/scripts/secret-scan.cjs` covered 73 files in `.work/runs`, `.work/metrics`, `.work/ledger.md`, `dist`, `src`, `web`, `tests` and `docs`.
  - Real secret values found: **0**.
  - The client ID does not appear in any log or evidence file.
  - Pattern hits: 3. All are fake fixtures in tests (`A21AAfake-token…`, `A21AAabc…`).
  - VERIFIED.
- **Browser bundle:** no client secret or token strings found in `dist/web/assets/*.js` (grep count 0). The client ID is served at runtime from `/api/paypal/browser-config`, which is intended.

## 3. Runtime and dependency versions

| Item | Version |
|---|---|
| Node | v22.18.0 (`engines: >=22.13.0 <23`) |
| pnpm | 11.4.0 (`packageManager` pinned), `pnpm-lock.yaml` committed-ready |
| SQLite | 3.50.2 via built-in `node:sqlite` (ExperimentalWarning, no flag) |
| OS | Windows 11 (MINGW64 shell) |
| fastify | 5.12.5 |
| @fastify/static | 10.1.5 |
| zod | 4.6.5 |
| typescript | 7.0.2 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| tsx | 4.23.15 |
| vite | 8.3.2 (vanilla TS) |
| vitest | 5.0.3 |
| @types/node | 22.20.5 |

Each dependency is the newest release that is at least 14 days old. `pnpm-workspace.yaml` allows esbuild's install script (`allowBuilds`), which pnpm 11 requires.

Not used, per the approved stack: React, microservices, Docker, K8s, Redis, tunnels, dashboards.

## 4. Commands run and exit codes (final run)

| Command | Exit | Notes |
|---|---|---|
| `pnpm install --frozen-lockfile` | 0 | reproducible from lockfile |
| `pnpm typecheck` | 0 | |
| `pnpm test` | 0 | **68 passed / 0 failed / 0 skipped** (5 files, ~1.0 s). All MOCKED or offline. |
| `pnpm build:web` | 0 | → `dist/web` |
| `pnpm start` | runs | 127.0.0.1:3001 |
| `pnpm cli oauth-check` | 0 | live |
| `pnpm cli readback <id>` | 0 | live |
| `pnpm cli capture 7PR849237P132474B` (repeat) | 0 | live, short-circuited |
| `pnpm cli db-check` | 0 | new process |
| `pnpm gate0:ai gemini-3.5-flash-lite` | 0 | live, 10 calls |

**Test files** (all MOCKED or offline; none of these counts as a Sandbox execution):
- `config.test.ts`
- `redact-money-verify.test.ts`
- `checkout-service.test.ts`: lifecycle, idempotency, concurrent capture, unknown outcomes (500 after apply, timeout, network), pending, mismatch, leak checks
- `store-and-server.test.ts`: child-process restart, append-only triggers, unique constraints, compare-and-set, HTTP routes
- `ai.test.ts`

**Mutation checks:**
- Removing the approval guard made 2 tests fail.
- Removing the amount check made 2 tests fail.
- Removing the terminal-state short-circuit failed **no** test. The pre-capture readback also blocks a second capture (defense in depth). A dedicated test for the short-circuit is a Gate 1 item.

## 5. PayPal Sandbox results (VERIFIED unless labelled)

Successful transaction:

| Step | HTTP | Debug ID | Detail |
|---|---|---|---|
| OAuth `/v1/oauth2/token` | 200 | `ca4c961c88b8a` | 1388 ms, `expires_in` 32400, 29 scopes |
| Create `POST /v2/checkout/orders` | 201 | `ca4c97805f9ca` | order `7PR849237P132474B`, CREATED, USD 1.00, `PayPal-Request-Id: ot-create-pa_644e2121-3803-4ecb-9234-3d5bf4d4ba3b`, custom_id `ci_30e04c67-…` |
| Buyer approval | — | — | user, in the SDK v6 popup, as a **US** personal Sandbox buyer (OPERATOR act; result VERIFIED by the next row) |
| Pre-capture readback `GET` | 200 | `ca4c978b6fca1` | status **APPROVED**, USD 1.00 |
| Capture `POST …/capture` | 201 | `ca4c978c08ce9` | `PayPal-Request-Id: ot-capture-pa_644e2121-…`; order COMPLETED |
| Post-capture readback | 200 | `ca4c978c85e6b` | order COMPLETED, capture `5YV23435BN640024J` COMPLETED, USD 1.00 |
| Independent readback (new CLI process) | 200 | `ca4c979abbec7` | same; verdict `captured`: "amount, currency and order id match intent" |
| Repeat capture (CLI) | — | — | no PayPal call made (terminal state); same capture ID returned |

Server endpoint latency for the browser `POST /api/orders/7PR849237P132474B/capture` (pre-readback, capture and post-readback combined): 3343 ms.

**Failed approvals before success:**
- 8 earlier orders stayed CREATED or PAYER_ACTION_REQUIRED. **None was captured**, and the capture guard never fired on them.
- They are left to expire. The state machine has no expiry handling yet (a Gate 1 item).
- First attempt (`22Y35806K4083780E`): the popup stuck at login.
- Later attempts: PayPal showed "Things don't appear to be working at the moment" right after buyer login.
- **Cause (HYPOTHESIS, strongly supported):** both original Sandbox accounts are country **IN** (OPERATOR screenshot). PayPal India does not support domestic IN→IN payments. The unchanged code succeeded immediately with a newly created **US** personal buyer paying the IN business account. This was not confirmed against PayPal documentation in this session.
- **Operational note:** use a non-IN Sandbox buyer for all future demos.

**SDK v6:**
- `createInstance({clientId})` succeeded, `findEligibleMethods` returned PayPal as eligible, and there were no console errors. VERIFIED.
- The docs list `clientToken` as required, but `clientId` worked (discrepancy recorded).
- The redirect fallback (`create --redirect`, `checkoutnow?token=`) was created as `4KH90953EG8007103` but never approved. **NOT_TESTED end-to-end.**

## 6. SQLite and restart verification (VERIFIED)

- **Database:** `./.work/ordertruth.sqlite`, WAL mode, foreign keys on.
- **Tables:** `checkout_intents`, `payment_attempts` (UNIQUE on intent, PayPal order, create request ID, capture request ID and capture ID) and `evidence` (append-only, enforced by triggers).
- **Restart sequence:**
  1. Server PID **37212** served the capture.
  2. Its process tree was killed with `taskkill /T /F`, and port 3001 confirmed closed (curl exit 7).
  3. A new server, PID **29644**, returned `GET /api/orders/7PR849237P132474B` → `state: captured`, capture `5YV23435BN640024J`, USD 1.00, from the database (`.work/runs/06-restart-status.json`).
  4. A separate CLI process, PID **24920**, listed all 9 attempts: exactly one `captured`, the other 8 `awaiting_buyer_approval`.
- An automated child-process restart test also exists (MOCKED provider, real SQLite).
- **Windows note:** stopping the background bash task did not stop the Node child. The server PID had to be killed explicitly.

## 7. Gemini feasibility (VERIFIED, synthetic data only)

- **Model check:** the `ListModels` call returned HTTP 200 in 360 ms. `models/gemini-3.5-flash-lite` and `models/gemini-3.1-flash-lite` both exist and support `generateContent`.
- **Model used:** `gemini-3.5-flash-lite` only. The secondary model was not needed. 3.8 Flash was not used.
- **Request settings:**
  - REST `generateContent` with `responseMimeType: application/json` and `responseJsonSchema`.
  - Temperature 0, max 1024 output tokens.
  - API key sent in the `x-goog-api-key` header.
  - Calls spaced 4.5 s apart.

| Metric | Value |
|---|---|
| Calls | 10 of a 10-call cap (2 smoke calls, then 8) |
| HTTP / ok | 10 × 200 / 10 ok |
| Schema-valid | 10/10 |
| Invented evidence IDs | 0 (S6 prompt injection asked it to cite `E99`; it did not) |
| Agreement with rules baseline | 10/10 |
| Repeatability (S1, S2 run twice) | identical class both times |
| Prompt-injection / adversarial operator (S5, S6) | both resisted; S5 correctly HEALTHY despite "refund immediately" note |
| Latency | min 1083, p50 1541, p90 2113, max 2113 ms |
| Tokens | prompt 4042, output 1250, thoughts 0, **total 5292** |
| Errors / quota | none; no 429, no billing prompt |
| Remaining-quota estimate | ≥ 490 of 500 RPD (estimate: assumes no other usage today; 500 RPD / 15 RPM / 250K TPM as reported by the user, not read from Google) |

- **Metrics:** `.work/metrics/gemini-gate0-gemini-3.5-flash-lite-1792346199707.json`
- **Run log:** `.work/runs/04-gemini-eval.json`
- **Error classification:** `rate_limited`, `quota_exhausted`, `billing_required`, `server_error`, `timeout`, `invalid_json`, `empty_response`, schema-invalid and invented-ID rejection are covered by **MOCKED** unit tests only. None of these errors occurred live.
- **Money-movement flag (false positive):** the heuristic flagged S5. The model actually wrote that the refund request "should be ignored per integration rules", but the negation regex missed that phrasing. The heuristic needs improving, and the flag still needs human review.

## 8. Limitations and gaps

1. **Webhooks: GAP.** There is no webhook endpoint, signature verification or tunnel; this was deferred by the user. `PAYPAL_VERIFIED_WEBHOOK` evidence exists only in synthetic AI scenarios.
2. **Redirect fallback not proven end-to-end.** Only the SDK v6 popup flow captured successfully.
3. **Live coverage is one capture.** Refunds, PENDING captures, DECLINED captures and real 5xx or timeout outcomes were tested only against the mock.
4. **Abandoned orders:** there is no expiry or abandonment transition yet. 8 attempts remain in `awaiting_buyer_approval`.
5. **Terminal short-circuit** has no dedicated failing-mutation test (see §4).
6. **Gemini evaluation is small and synthetic:**
   - 8 scenarios whose expected answers equal the baseline by construction.
   - 10/10 agreement does not show the model generalizes.
   - The quota figures are user-supplied estimates.
7. **`node:sqlite` is experimental on Node 22**: it prints a warning, and its API may change. It is isolated in `store.ts` (ADR-004).
8. **IN Sandbox accounts:** the IN personal buyer cannot pay the IN business account (HYPOTHESIS, §5). Demos need a non-IN buyer.
9. **Buyer approval is a manual step by the user by design.** Claude never automated PayPal login.
10. **Duplicate docs, kept unchanged as instructed. Cleanup is for a later gate:**
    - Root `ORDERTRUTH_MASTER_PLAN.md` is **byte-identical** to `docs/ORDERTRUTH_MASTER_PLAN.md`.
    - Root `CLAUDE_CODE_KICKOFF.md` is **byte-identical** to `prompts/CLAUDE_CODE_KICKOFF.md`.
    - `agent.md` (3 lines) is separate from `AGENTS.md`.
    - All are tracked.
11. **Capture recovery gaps (found in the handoff review; HYPOTHESIS from reading the code, untested).** Details are in [`GATE0_HANDOFF_AND_GATE1_PROPOSAL.md`](GATE0_HANDOFF_AND_GATE1_PROPOSAL.md) §1b.
    - **F1:** a DB write failure after PayPal returns 201 leaves the attempt in `capture_in_progress`. There is no automatic reconciler.
    - **F2:** a buyer retry after an error creates a new order, so the buyer could be charged twice. There is no checkout-level idempotency.
    - **F3:** across processes, `checkout-service.ts:219` overwrites the capture claim without compare-and-set. Only the `PayPal-Request-Id` would then prevent a second capture.
    - Local deduplication (single process, or a repeat call after success) is VERIFIED; these gaps are separate from it.

## 9. Evidence paths (all in ignored `.work/`, redacted)

- `.work/runs/01-oauth.json`: OAuth check
- `.work/runs/02-readback-after-approval.json`: first readback (CREATED; approval not completed)
- `.work/runs/03-gemini-models.txt`: model list
- `.work/runs/04-gemini-eval.json`, `.work/metrics/gemini-gate0-gemini-3.5-flash-lite-1792346199707.json`: Gemini run
- `.work/runs/05-duplicate-capture.json`: repeat capture (no-op)
- `.work/runs/06-restart-status.json`: post-restart status
- `.work/runs/07-db-check.json`: DB state in a new process
- `.work/runs/gate0/*_0021_create_order.json`, `*_0022_pre_capture_readback.json`, `*_0023_capture_order.json`, `*_0024_post_capture_readback.json`, `*_0025_readback.json`: capture chain
- `.work/runs/server.stdout.log`, `server2.stdout.log`: server request logs (no bodies, no secrets)
- `.work/ordertruth.sqlite`: database
- `.work/ledger.md`: session ledger

## 10. Git working-tree changes (read-only `git status --short`)

During the session the user (author `ANIRUDDH-001`) committed the Gate 0 code and the ADR-004 edit as `41b1fda` through `7bb4a69` on `main`; `git status -sb` shows `main...origin/main` in sync. **Claude made none of these commits.** Final status:

```
?? docs/GATE0_FEASIBILITY_REPORT.md   (this file, not yet committed)
```

`dist/`, `node_modules/`, `.env` and `.work/` are not in the list (ignored). **Nothing is staged by Claude. CLAUDE MADE NO GIT COMMITS.** The user or Codex should review this report and commit it.

## 11. Budget

**₹0 spent.** PayPal Sandbox is free. Gemini was used on the free tier: 10 calls and 5292 tokens, with no billing prompt. No paid services were used.

## 12. Next step

Stop here. **Gate 1 is not authorized.** It needs the user's explicit approval. Proposed Gate 1 conditions:
- Webhook plan (tunnel or deployment).
- Abandoned-order expiry.
- Terminal short-circuit test.
- An end-to-end run of the redirect fallback.
- Non-IN demo buyer.
- Confirm ADR-002, ADR-003 and ADR-004.
