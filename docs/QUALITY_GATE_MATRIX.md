# Quality gate matrix — status: NOT TESTED

The rows below are **criteria**, not passes. Replace status only with reproducible evidence and exact safe command or test.

| Dimension | Gate target | Initial status | Evidence path |
|---|---|---|---|
| Sandbox | Approved captured order + authoritative readback | NOT TESTED | .work/runs/... redacted |
| Money correctness | Server amount, currency, request idempotency | NOT TESTED | tests/... |
| Payment failure | Unknown/pending/denied correctly represented | NOT TESTED | tests/... |
| Persistence | Restart retains business state | NOT TESTED | tests/... |
| Concurrency | Single logical merchant order despite concurrent handler | NOT TESTED | tests/... |
| Webhook authenticity | Signature checks, dedup, reordering | NOT TESTED | tests/... |
| Recovery | Explicit approval, exactly-once local repair, postcondition | NOT TESTED | tests/... |
| AI | Model quota proven, hypotheses grounded, beats baseline on measured task | NOT TESTED | docs/GATE0... |
| Security | Secrets, auth, org isolation, injection tests | NOT TESTED | tests/... |
| UX engineering | Engineer trace-to-regression completed | NOT TESTED | tests/e2e/... |
| UX operations | Operator impact-to-verified-resolution completed | NOT TESTED | tests/e2e/... |
| Accessibility | WCAG AA-target audit, keyboard, contrast, no critical axe findings | NOT TESTED | reports/local/... |
| Performance | Web vitals and request latency measured under representative load | NOT TESTED | .work/metrics/... |
| Cost | Actual incremental spend ₹0 and bounded provider usage | NOT TESTED | .work/ledger.md |
| Reproducibility | Fresh checkout/install/test/run | NOT TESTED | docs/GATE0... |
| Submission | License, public code, YouTube <3min, judge access through Dec 15 | NOT TESTED | docs/RELEASE_CHECKLIST.md |
