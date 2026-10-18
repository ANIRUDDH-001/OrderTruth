# Quality gate matrix — status: PARTIAL (Gate 0 live + Gate 1A mocked/local evidence)

The rows below are **criteria**, not passes. Status changes only with reproducible evidence and an exact safe command or test.
Labels: **VERIFIED-LIVE** (PayPal Sandbox), **VERIFIED-LOCAL** (real local processes/SQLite, MOCKED provider), **NOT TESTED**.
A row is never "done" on MOCKED evidence alone where the criterion is about real provider behaviour.

| Dimension | Gate target | Status (2026-10-19, after Gate 1A) | Evidence path |
|---|---|---|---|
| Sandbox | Approved captured order + authoritative readback | VERIFIED-LIVE at Gate 0 (1 capture, USD 1.00). No Sandbox call in Gate 1A | `docs/GATE0_FEASIBILITY_REPORT.md`, `.work/runs/gate0/` (ignored) |
| Money correctness | Server amount, currency, request idempotency | VERIFIED-LOCAL: server-owned amount; stable create/capture request ids reused on every retry (A4, A4b, A6, P3). PayPal-side idempotency/retention window: NOT TESTED live | `tests/gate1a-recovery.test.ts`, `tests/gate1a-processes.test.ts`, `tests/store-and-server.test.ts` |
| Payment failure | Unknown/pending/denied correctly represented | VERIFIED-LOCAL: timeout → `uncertain` (never `approved`), settle window, 503 `outcome_unknown` after local failure, pending → captured by reconciler (A1, A1b, A5, A6) | `tests/gate1a-recovery.test.ts`, `tests/checkout-service.test.ts` |
| Persistence | Restart retains business state | VERIFIED-LOCAL: forced process kill after PayPal 201 and before POST; restart reconciles by readback (P2, P3). Gate 0 live restart also VERIFIED-LIVE | `tests/gate1a-processes.test.ts` |
| Concurrency | Single logical merchant order despite concurrent handler | VERIFIED-LOCAL for 2 OS processes sharing one SQLite file on one host: one claim, exactly 1 capture POST (P1, A10); same checkout key → one intent (A4); DB trigger blocks illegal transitions (A9, A9b). Multi-instance production: NOT CERTIFIED (D6) | `tests/gate1a-*.test.ts` |
| Webhook authenticity | Signature checks, dedup, reordering | NOT TESTED (Stage 1B, not authorized yet) | — |
| Recovery (merchant repair) | Explicit approval, exactly-once local repair, postcondition | NOT TESTED. Gate 1A covers **payment** reconciliation by PayPal readback only, which is distinct from merchant-side repair verification (D5, later stage) | — |
| AI | Model quota proven, hypotheses grounded, beats baseline on measured task | Gate 0 feasibility only (10/10 schema-valid); "beats baseline" NOT TESTED | `docs/GATE0_FEASIBILITY_REPORT.md` |
| Security | Secrets, auth, org isolation, injection tests | PARTIAL: secret redaction tests + secret scan of changed files (0 real values). Origin/CSRF (G1-S02), auth, org isolation: NOT TESTED | `tests/redact-money-verify.test.ts`, `docs/GATE1A_RESULTS.md` |
| UX engineering | Engineer trace-to-regression completed | NOT TESTED | — |
| UX operations | Operator impact-to-verified-resolution completed | NOT TESTED | — |
| Accessibility | WCAG AA-target audit, keyboard, contrast, no critical axe findings | NOT TESTED | — |
| Performance | Web vitals and request latency measured under representative load | NOT TESTED | — |
| Cost | Actual incremental spend ₹0 and bounded provider usage | VERIFIED for Gate 1A: ₹0, zero PayPal Sandbox calls, no paid services | `.work/ledger.md` |
| Reproducibility | Fresh checkout/install/test/run | Gate 0 clean export VERIFIED-LOCAL at HEAD 7bb4a69. Gate 1A working tree: typecheck/test/build pass locally; fresh-clone run NOT TESTED (changes uncommitted) | `docs/GATE1A_RESULTS.md` |
| Submission | License, public code, YouTube <3min, judge access through Dec 15 | NOT TESTED | `docs/RELEASE_CHECKLIST.md` |
