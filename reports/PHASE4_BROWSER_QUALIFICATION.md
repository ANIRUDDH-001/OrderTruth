# Phase 4 browser qualification

7 November2026 IST. **VERIFIED LOCAL ONLY; hosted qualification NOT_TESTED.** Codex built-in browser, real Fastify/session handlers, owned PostgreSQL18 on loopback55432, Node22.18.0, pnpm11.4.0. External provider/model fetch rejected by the local harness before network access. Genuine historical Sandbox observation E34 retains its original19October timestamp/provenance; no fresh capture/readback or AI inference occurred.

Source: approved base `f3d873f32e130ca041a5653e79e96fb9832e5458` plus Phase4 working-tree changes for initial campaign. Exact committed-build confirmation is appended at publication. Private source/runtime identity: `.work/qualification/runtime.json`; route-template logs `.work/qualification/requests.jsonl`; screenshots and `browser-summary.json` under `.work/qualification/phase4/`. These local artifacts are ignored, not public portable attestation.

| Flow | VERIFIED observation | Screenshot/evidence filename |
|---|---|---|
| Entry/session | Real local sign-out handler ends previous guest session; overview shows connection confirmed and private-session explanation; Inspect establishes a fresh guest and UUID case referencing E34 | `first-visit.png`, `fresh-session-case.png` |
| Historical provider facts | E34 original genuine Sandbox provenance, recorded COMPLETED/USD1.00, explicitly no fresh PayPal call; merchant totals labelled separately | `receipt-desktop.png` |
| Interrupted creation | Actual POST handler commits; one response truncated by local transport fault. UI retains uncertainty/UUID; explicit read-only resume finds original owned case | `creation-interrupted.png`, route log |
| Duplicate/detection | One controlled merchant order added; persisted deterministic finding shows two active orders for one observation | Browser AX snapshots |
| AI unavailable | Actual disabled-adapter response shows rules-based guidance and no causal/model-execution claim | Browser AX snapshots |
| Optional diagnostics | Actual idempotency-key comparison records two distinct merchant write keys | Browser AX snapshots |
| Exact approval |2→1 plan; keeper/void scope; no PayPal effects; server expiry; approval via Enter, execution separate | Browser AX snapshots |
| Interrupted execution | Real approved execution commits; truncated response yields uncertain state with mutations disabled | `execution-interrupted.png` |
| Independent receipt | Explicit GET reopens SUCCEEDED; one active matching keeper; stored provider evidence unchanged | `receipt-desktop.png` |
| Separate-process verification | A fresh Node process calls real PostgreSQL receipt verification, currentVerified=true/SUCCEEDED | `.work/runs/phase4-sql-verification.json` |
| Maintenance entry | Atomic local barrier CLOSED; status reports closed/zero; actual session requests503; after bounded GET retries UI says session unconfirmed/maintenance, new case disabled | `maintenance-closed.png` |
| Maintenance exit/restart | Set OPEN, stop owned backend and PG, verify backend unavailable, restart both; same browser session/case reopens SUCCEEDED without replay | `receipt-after-full-restart.png` |
| Refresh/reopen | Browser reload re-reads durable state and preserves receipt | `receipt-mobile390.png` |
| Mobile |390×844: merchant and Lab document scrollWidth375≤390; responsive navigation remains usable | `receipt-mobile390.png`, `lab-mobile390.png` |
| Keyboard/navigation | Enter approval/execution and Lab navigation; return to merchant reopens receipt; operations/engineering switch works | AX state and return receipt |
| Console | Browser captured error/warn list empty on final return | Browser tool output |

Local transport fault hooks exist only in the test harness, never hosted-main. They truncate responses after real handlers and do not manufacture successful application/database states. Browser session ownership remains real; direct SQL verification is separately labelled and does not substitute for browser behavior.

The maintenance counter does not certify a previous hosted process has exited. Unit/integration tests separately prove pre-body webhook refusal503, owner capture refusal, in-flight request drain, lost-response conservatism and stale/mismatched browser source rejection. Genuine signature/HTTPS webhook redelivery and production cutover remain NOT_TESTED. Full screen-reader/WCAG2.2AA certification, continuous access through December15, controlled15minute idle-wake timing and saved-file receipt export are NOT_TESTED.

## Reproduction

Use `scripts/qualification.ps1 build`, then `serve`; all fixtures/data stay in owned local PostgreSQL. A separately imported historical observation is required for genuine historical provenance; synthetic setup button remains distinctly labelled. Root credentials are never inherited by the qualification process. Close the barrier by atomically replacing `.work/qualification/release-barrier` with `CLOSED`; reopen with `OPEN`. Unreadable/invalid state fails closed. Stop with `qualification.ps1 stop` and `stop-db`; source/main/provider adapters are not altered to fake a pass.

The authorization request and hosted stop conditions are in `PHASE4_V9_CUTOVER_RUNBOOK.md`. None of this local evidence authorizes hosted mutations.
