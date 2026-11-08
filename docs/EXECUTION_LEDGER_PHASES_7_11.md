# OrderTruth execution ledger — phases 7–11

## 8 November 2026 — first release candidate

Goal: release the qualified Phase 6 payment/navigation fixes with AI disabled, and prepare private Gemini/Groq configuration.

Baseline verified against remote: main `575433adfe6ba15e593241898f55a962f77e1fec`; Phase 6 `a57fff26e151308295976cf79cab79fdd492eb9d`. Its exact CI `42441277559` succeeded. The current mandate authorizes normal commits, pushes, integration and coordinated releases; older reports' approval restrictions are historical. New captures/webhook administration remain separately scoped.

Implemented: dedicated private key placeholders, Gemini legacy-key migration with conflicting-alias rejection, redaction of both provider keys, configuration instructions in `AI_CONFIGURATION.md`. Existing local environment bytes preserved. Inference remains disabled; Groq hosted selection and comparative live value remain unqualified.

The release operator previously rejected every database-layer code change. A new policy permits only the reviewed before/after Git blobs for the Phase 6 checkout-state fix. All other database changes remain blocked; schema9, drain, fingerprints and coordinated HOLD/NORMAL gates remain mandatory. Independent review found no actionable issue in this narrow exception or the configuration changes. Actual Render configuration remains one free instance, autodeploy disabled; no plan change was performed.

Local verification on Node22.18.0/PostgreSQL18: 1,310 offline tests, 64 V2 PostgreSQL tests, 114 V3 PostgreSQL tests, both typechecks and frontend build passed. New tests first reproduced missing named-key behavior and the missing reviewed-blob policy, then passed after implementation. Synthetic owner bootstrap was subsequently added only to the unserved loopback qualification helper; final exact-source CI remains required.

Built-in browser: actual HTTP/PostgreSQL synthetic case → duplicate → detection → honest AI unavailable → key diagnostic → exact plan → approval → local correction → receipt → reload → read-only recheck. Independent SQL confirmed active1/voided1, one successful outcome, equal provider hashes and original synthetic capture intact. Desktop1440/mobile390 showed no horizontal overflow. Owner form focus, actual fixture sign-in, owner checkout link, absence of redundant owner sign-in, sign-out, first-visitor page and optional Lab navigation verified. Checkout SDK displays an initialization failure with deliberately synthetic credentials; genuine checkout is NOT TESTED here. One observed UX follow-up: authenticated owner landing still uses guest-oriented readiness copy.

Evidence: ignored `.work/runs/phase7/` test logs, screenshots, sanitized HTTP logs and SQL proof. Source is baseline SHA plus the current reviewed diff until the candidate commit is recorded. No new Sandbox capture, webhook registration or live inference occurred. Incremental external spend introduced: ₹0; assistant inference metering unavailable.

CI / hosted release: PENDING. Existing receipts must be reopened read-only after a coordinated release; no release PASS is claimed yet.

Next: secret-scan and commit candidate, exact-source CI, coordinated source/schema/evidence-preserving release, hosted browser verification. In parallel, an isolated implementation worktree is closing F6-04 with typed checkable claims and backend-rendered prose; it is excluded from this first candidate.
