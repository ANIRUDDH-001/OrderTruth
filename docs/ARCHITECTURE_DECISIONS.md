# OrderTruth — Architecture decision record

Store **only durable, non-sensitive** decisions here. Detailed local agent scratch notes belong in ignored `.work/ledger.md`. Each new ADR must include date, status (`proposed/accepted/reversed`), decision, alternatives, evidence, consequences and user approval when needed.

## ADR-001 — Two complete workspaces, shared incident domain
**Status:** Accepted by product owner 2026-10-18. Engineers are the initial target buyers; merchant operators are full-featured secondary users, not a toy extension. Shared truth store; role-appropriate views/actions. Separate independent OrderTruth branding.

## ADR-002 — No production money or external repair in prototype
**Status:** Proposed safety contract; verify with user before Gate 1. Sandbox PayPal checkout only; corrections permitted only in the controlled reference merchant under explicit approval. No AI-authorized financial API mutations.

## ADR-003 — Single service and SQLite first
**Status:** Proposed, not final. Favor a modular monolith and SQLite for reproducible local demo; must test persistence, concurrent access and restart. Reconsider based on measured requirements, not scale speculation.

## ADR-004 — Gate 0 runtime choices: node:sqlite, raw Orders v2 REST, SDK v6 script tag
**Date:** 2026-10-18. **Status:** Proposed (adopted for Gate 0 only; confirm with user before Gate 1).
- **Decision:** (1) Use built-in `node:sqlite` (Node 22.18, SQLite 3.50.2) behind a single module `src/db/store.ts`. (2) Call PayPal Orders v2 over raw `fetch` (OAuth, create, capture, GET) from `src/paypal/client.ts` instead of `@paypal/paypal-server-sdk`. (3) Load the PayPal JS SDK v6 from PayPal's Sandbox script URL; no `@paypal/paypal-js` package.
- **Alternatives:** `better-sqlite3` (native build step, extra dependency); PayPal server SDK (used by PayPal's official v6 sample, but that sample computes amounts with floats and hides the request ID and debug ID); `@paypal/paypal-js` loader.
- **Evidence:** node:sqlite probe passed WAL, foreign keys, unique constraints, `BEGIN IMMEDIATE`, append-only triggers and a child-process restart test (see `docs/GATE0_FEASIBILITY_REPORT.md`). Raw REST gives direct control over `PayPal-Request-Id`, `paypal-debug-id`, timeouts and integer minor-unit money. A live Sandbox capture with readback succeeded using these choices.
- **Consequences:** `node:sqlite` prints an ExperimentalWarning on Node 22, and its API may change. Isolating it in `store.ts` keeps a swap to `better-sqlite3` to one file. With raw REST we maintain the request and response types ourselves, and new PayPal fields must be added by hand.

## ADR-005 — Stage 1C: evidence-linked merchant contract, labelled fault, single incident class
**Date:** 2026-10-19. **Status:** Proposed (implemented for review; awaiting user approval).
- **Decision:** (1) The reference merchant's orders live in the same SQLite store through additive migration 4, scoped by `organization_id`. (2) There is one explicit contract, `REF_MERCHANT_ONE_CAPTURE_ONE_ORDER_V1`, evaluated by a pure function. Eligibility requires the newest HTTP-200 `PAYPAL_API_READBACK` showing a capture to confirm the local capture exactly. (3) Duplicates are produced only by a durable, DB-labelled `CONTROLLED_FAULT_INJECTION` (or detected organically with cause `UNKNOWN`), never simulated in the incident record itself. (4) Incidents open only from a persisted VIOLATED evaluation (DB trigger), are deduplicated per org + contract + intent, and link evidence through a trigger that checks each label against the record it names. (5) A capture event against a capture-less successful readback is retried, not disagreed.
- **Alternatives:** a unique key on `merchant_orders.intent_id` would hide the defect OrderTruth must detect; a separate merchant DB would add a second persistence boundary without evidence of need; an AI or heuristic detector is excluded by scope; treating every readback mismatch as terminal caused the Gate 1B stale-readback risk.
- **Evidence:** `docs/STAGE1C_RESULTS.md`. 310/310 tests; 7/8 mutations killed, with the 1 survivor explained; healthy vs fault on byte copies of the real DB with the source sha256 unchanged.
- **Consequences:** merchant orders and incidents are immutable until an approved repair stage adds audited transitions. `x-ordertruth-org` is a dev-only scope, not authentication. `Store` auto-migrates the live DB on its next open, so snapshot first.
- **Amendment (2026-10-19, review of `a36852d`; uncommitted):**
  - (a) The contract compares every placed order with the captured payment: attempt, PayPal order id, capture id, SKU, currency and amount. Only matching orders count toward HOLDS/VIOLATED. Mismatched orders yield OUT_OF_SCOPE with explicit reasons; no new incident class. Migration 5 enforces the same match on insert, still without a unique key on `intent_id`.
  - (b) Cause is attributed only through the involved orders' own fault references (`CONTROLLED_FAULT_INJECTION` / `MIXED` / `UNKNOWN`). Unreferenced fault records are preserved but not treated as the cause.
  - (c) The repair design moved to `docs/STAGE1C_REPAIR_CONTRACT.md`. It uses append-only voids and resolutions instead of mutable orders and incidents, and is not implemented.
  - Evidence: 335/335 tests; 16/16 targeted mutations killed after strengthening (3 first-pass survivors reported).

### ADR-006 — Stage 1D append-only local repair journal (2026-10-19)
Status: product-owner authorized local implementation; human demonstration still requires independent review and exact interactive approval.
Use immutable plans/execution identities with append-only approvals, EXECUTING transitions, unique terminal outcomes, order voids, incident resolutions and audit. Keep the original merchant/order incident statuses unchanged; derive effective state from committed facts. Serialize SQLite writers with BEGIN IMMEDIATE. Roll correction back to a savepoint and commit a refusal in the outer transaction, removing the two-transaction audit-loss window. Before COMMIT a crash leaves no repair; after COMMIT retries return the durable outcome. No provider client is available to repair code. CLI declarations are not authenticated identity or RBAC. No exposure or production readiness is implied.
