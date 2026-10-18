# Gate 1A results — capture recovery (sanitized)

**Date:** 2026-10-19 · **Author:** Claude Code (Opus 5.5) · **Scope:** Gate 1A only (D4 + additional requirements 1–8).
No tunnel, no webhook, no Sandbox call of any kind, no merchant module, no fault-injection switch. **CLAUDE MADE NO GIT WRITES.**
Design: [`GATE1A_DESIGN_REVIEW.md`](GATE1A_DESIGN_REVIEW.md). Raw local logs: `.work/runs/gate1a/` (ignored).

```
STATUS: Gate 1A — GO for review (all acceptance tests pass locally; provider MOCKED). STOPPED before 1B.
VERIFIED: see §1 (commands + observed results)
NOT TESTED: see §4
IMPLEMENTED: see §2
TESTS: 88 passed / 0 failed / 0 skipped (baseline 68 + 20 new); 5 pre-existing tests changed, see §3
RISKS: see §5
COST / QUOTA: ₹0; 0 PayPal Sandbox calls; 0 Gemini calls in Gate 1A
BLOCKING QUESTIONS: none for 1A; 1B needs your approval (§6)
NEXT ACTION: your review of this report and the diff; then approve or amend Stage 1B
GIT: status only; CLAUDE MADE NO GIT COMMITS
```

## 1. Verified evidence (VERIFIED-LOCAL; provider = `tests/fake-paypal.ts`, never the Sandbox)

| Check | Command | Observed |
|---|---|---|
| RED first | `pnpm exec vitest run tests/gate1a-recovery.test.ts tests/gate1a-processes.test.ts` on the unchanged code | 19 failed / 1 passed (A7: see mutation M1). Failures for the intended reasons: `database is locked` surfaced raw, `expected 'approved' to be 'uncertain'`, missing `transition`/`attempt_transitions`, missing `src/server/start.ts` |
| Typecheck | `pnpm typecheck` | exit 0 |
| Full suite | `pnpm test` | 7 files, **88/88 pass** |
| Process tests ×3 (flakiness) | `pnpm exec vitest run tests/gate1a-processes.test.ts` three times | 3/3 pass each run |
| Web build | `pnpm build:web` | exit 0 |
| Mutation M1: remove terminal short-circuit | sed mutant → tests → restore (byte-identical, `cmp`) | A7 fails (F5 now has a test that bites) |
| Mutation M2: remove settle window | same | A6 + the updated timeout test fail |
| Mutation M3: rethrow raw local error after the POST | same | A1 + A1b fail |
| Mutation M4: ignore a fresh foreign claim | same | A10 fails |
| Migration on a **copy** of the Gate 0 DB | `node --import tsx .work/runs/gate1a/mig-check.ts <copy>` | schema v1→v2; states unchanged (8 `awaiting_buyer_approval`, 1 `captured`); 25 evidence rows unchanged; 27 transition rows. The original `.work/ordertruth.sqlite` was not opened |
| Secret scan of every changed/new file | regex for token/secret shapes | 0 real values; 1 intentional fake canary token in `tests/fake-paypal.ts` (pre-existing) |

Acceptance tests (all pass):

| ID | What it proves | Real? |
|---|---|---|
| A1 | A real `SQLITE_BUSY` (second connection holds the write lock) right after PayPal's 201 → `503 outcome_unknown`, exactly 1 POST, never `approved`; a retry settles to `captured` with **no** further POST | real SQLite lock |
| A1b | DB evidence write fails after the 201 → `outcome_unknown`; the reconciler alone reaches `captured`, 1 POST total | real SQLite |
| A2 | Evidence-file mirror fails after the capture → still `captured`; `evidence_file_write_failed` logged; DB evidence complete | real FS failure |
| A3/A3b | Same `x-checkout-key` → same order (`reused: true`), 1 create POST; after capture → `409 checkout_already_paid`; while uncertain → `409 checkout_in_progress`; missing/short key → 400 | HTTP inject |
| A4/A4b | Concurrent same-key creates from 2 services on one SQLite file → one intent/attempt/order id; every create POST uses the same request id; a create timeout stays `created` and the retry reuses the request id | real SQLite |
| A5/A5b | Reconciler issues only GET (+OAuth) across stale claim / pending / captured-but-unrecorded; writes only `PAYPAL_API_READBACK`; skips a fresh claim | — |
| A6 | Timeout then immediate APPROVED readback → `uncertain`; retry at +5 s → `409 capture_outcome_pending`, no POST; after 120 s → one POST with the **same** `ot-capture-<attemptId>` | injected clock |
| A7 | Capture of a captured order makes zero provider calls | — |
| A8/A8b/A8c | Readback without `custom_id` → `mismatch`; pre-capture foreign or missing `custom_id` → `409 provider_mismatch`, no POST | — |
| A9/A9b | DB trigger rejects `capture_in_progress → approved` even via raw SQL; `updateAttempt` cannot write `state`; DB transition table equals the TS map | real SQLite |
| A10 | Service B cannot reset A's in-flight claim; exactly 1 POST | real SQLite |
| **P1** | **Two OS processes**, one SQLite file, HTTP fake: B's capture during A's in-flight POST → `409 capture_in_progress`; exactly 1 POST; DB `captured` | real processes |
| **P2** | **SIGKILL right after PayPal's 201** (DB still `capture_in_progress`, fake order COMPLETED) → restarted process's startup reconcile reaches `captured`; 0 extra POSTs | real crash |
| **P3** | **SIGKILL after the claim, before the POST** → restart reconciles to `uncertain` with 0 POSTs; explicit retry → 1 POST whose header equals the stored request id | real crash |

## 2. Implemented (smallest safe change)

- `src/domain/checkout.ts` — exported `TRANSITIONS`; removed `capture_in_progress/uncertain → approved`, `created → uncertain` and the direct `awaiting_buyer_approval → capture_in_progress`; a missing `custom_id` is a correlation failure; any correlation failure without a capture is `mismatch`.
- `src/db/store.ts` — additive migration 2: `checkout_key` (unique index), `capture_claims`, `capture_claimed_at_ms`, static `attempt_transitions` table + state-guard trigger + initial-state trigger. `transition()` (CAS on legal predecessors, optional claim-counter guard), `refresh()`, `attachOrder()` (first writer wins), settle-aware `claimCapture()`, `getIntentByCheckoutKey`, `getAttemptByIntentId`, `listUnsettled`. `updateAttempt` can no longer write `state`. Migrations now run inside one write lock. Configurable `busyTimeoutMs`.
- `src/checkout-service.ts` — durable checkout intent per key (in-process single flight + cross-process unique key); best-effort evidence files; everything after the claim is wrapped so local failure → best-effort `uncertain` + `503 outcome_unknown`; pre-capture mismatch refusal; settle window; `reconcile()` (GET only, skips in-flight/fresh claims, guarded writes); new error codes with non-sensitive `details`.
- `src/server/start.ts` (new) — startup reconcile before listening, then an unref'd interval. Used by `main.ts` (60 s) and the process tests.
- `src/server/app.ts` — `POST /api/orders` requires `x-checkout-key`; error responses include `details`.
- `src/runtime.ts` — settle = max(120 s, 4 × HTTP timeout); stale = max(60 s, 4 × HTTP timeout).
- `src/cli.ts` — new signature; new read-only `pnpm cli reconcile`.
- `web/main.ts` — keeps the checkout key in `localStorage` (try/catch, in-memory fallback), sends it, clears it on a final state, shows "do not pay again" for unknown/pending outcomes. No other UI work.
- Tests: `tests/gate1a-recovery.test.ts`, `tests/gate1a-processes.test.ts`, `tests/helpers/fake-paypal-http.ts`, `tests/helpers/server-process.ts` (test harness, never imported by `src/`), fake extensions in `tests/fake-paypal.ts`.

## 3. Pre-existing tests changed (stated explicitly)

1. `checkout-service.test.ts` "timeout on capture with nothing applied: **stays approved**" → now "**uncertain**, immediate retry refused (settle window)". This is the behaviour change you required in D4 ("do not equate an immediate APPROVED readback after a timeout with definitive proof").
2. `store-and-server.test.ts` "claimCapture is compare-and-set" — reaches `approved` via `attachOrder` + `transition` because `updateAttempt` can no longer write `state`. The assertion is unchanged.
3. Three HTTP tests in `store-and-server.test.ts` now send `x-checkout-key`, which is required. Their assertions are unchanged.

## 4. Not tested / not done

- PayPal's real request-id idempotency, its retention window (R4), and live behaviour of a late-landing capture after the settle window. The settle-window retry relies on these. **NOT TESTED live**; possible only in 1C, with your per-capture approval.
- Multi-instance production, network filesystems, and more than 2 processes. node:sqlite is **not certified** for these (D6).
- Webhooks, the tunnel, merchant-side repair verification (D5), fault-injection switch, abandoned-order expiry (G1-R07), Origin/CSRF (G1-S02).
- Browser checkout-key flow in a real browser: the build passes, but it was **not exercised** (no Sandbox session in 1A).
- A fresh-clone run of the Gate 1A working tree (the changes are uncommitted).

## 5. Top risks and mitigations

1. **Settle-window retry depends on unverified PayPal idempotency.** Mitigation: same stored request id, PayPal's single-capture order semantics, an explicit caller action only (the reconciler never captures), a conservative default window. Verify live in 1C.
2. **SQLite single host.** Mitigation: all access stays behind `Store`, with guarded transitions plus a DB trigger. Swap to Postgres before any multi-instance deploy.
3. **Orphan PayPal order on a cross-process create race.** Real PayPal should return the same order for the same request id; if it does not, the losing order is logged (`create_order_lost_race`) and can never be captured here, because it is unknown locally. It is never charged. Expiry of uncaptured orders is G1-R07 (later).

## 6. Before you run the real server again

The next `pnpm start` or `pnpm cli` against `.work/ordertruth.sqlite` applies **additive** migration 2. It was verified on a copy (§1). A backup first is recommended (stop the server, then copy the file).

Stage 1B (webhook ingress, tunnel) needs your explicit approval. Nothing for it has been started.
