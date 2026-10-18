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
