# OrderTruth — Master Product & Engineering Plan

**Status:** Decision-backed design; **not** a verified implementation. **Version:** 0.1, 18 October 2026.  
**Target working directory:** `D:\Projects\OrderTruth` (Windows).  
**Budget:** ₹0 incremental spend. **Competition:** PayPal AI Hackathon (Devpost).  
**Product positioning:** Independent, PayPal-connected payment-outcome assurance platform. Not affiliated with or endorsed by PayPal.  
**Audience:** Checkout/payment engineers are initial buyers; merchant operators are first-class users with a complete and independent workflow.  
**Working thesis:** The payment provider can correctly process money while the merchant's order, inventory, access, or fulfillment state is incorrect.

**Execution amendment — 2026-10-21:** The owner authorized a full hosted interactive application with reproducible local workflow, isolated controlled merchant scenarios referencing genuine immutable Sandbox observations, fresh useful AI, exact session approval and verified merchant-only repair. PostgreSQL must pass the bounded API/concurrency/recovery checkpoint; no payment cloning, paid fallback or hosted viewer substitution. November 7 feature freeze and November 9 video remain delivery checkpoints. See ADR-006 and `docs/POSTGRES_LOCAL.md` for current implementation boundaries; older SQLite/development-header descriptions below are historical design context, not public authentication or hosting claims.

> The intent of this document is to make claims **testable**, risks visible **before coding**, and stop decisions explicit. An impressive but unverified dashboard is failure; a functioning but undifferentiated tester is also failure.

## 0. Hard facts, open claims, decisions

### Facts verified from official sources
- Hackathon deadline: **12 November 2026, noon Pacific Standard Time** = **13 November 2026, 01:30 IST**. Recheck the live countdown before submission. Judges evaluate in December; keep judge access functional through **15 December 2026**.
- No fixed tracks; meaningfully use **PayPal's free Sandbox** and **AI**. A functional local run with clear setup can qualify; hosted deployment is optional. Public source code with an open-source license, project description, named AI tools, and a public YouTube demo **under 3 minutes** are required.
- Technical implementation, design, real impact, innovation, and presentation are **equally weighted** in Stage Two, after a Stage One viability screen.
- PayPal's **JavaScript SDK v6** is now documented for new integrations. Its current official guide recommends client ID for standard one-time checkout, with a client token for Fastlane. Some portions of PayPal documentation show older or contradictory examples: inspect the exact current page and working sample before implementation.
- PayPal retries unsuccessful webhooks and requires authenticity verification; webhook event delivery does **not** by itself guarantee merchant outcome.

### User-confirmed constraints
- Developer Dashboard access and a Sandbox REST application are visible. **No authenticated Sandbox OAuth/create/approve/capture/readback has been proven in this repo yet.** A separate connected PayPal app once returned `MERCHANT_RECEIVE_MONEY_DISABLED` while listing payment links; this does not establish Sandbox failure.
- The user will put credentials into the local `.env` **on their own**. Do not request secrets in chat, commit them, log them, or copy them into browser-side code.
- Pay ₹0. Do not enable paid tiers, card verification, trial subscriptions, external compute, SMS, paid hosting, or models without explicit authorization.
- Claude Code **MUST NOT run `git add`, `git commit`, `git push`, `git tag`, `git reset`, `git rebase`, `git cherry-pick`, or `gh pr create`**, or perform any other repository-history/remote mutation. The **user or Codex or an explicitly approved Google Antigravity agent** may handle commits. Codex also asks approval before commits.
- Ask clarifying questions about consequential ambiguities, provide frequent milestone updates, and keep private working notes in ignored `.work/`.

### Hypotheses, not yet proven
- Developers will adopt a tool that reconstructs and verifies post-payment business outcomes.
- Operator-level recovery workflows will decrease time-to-resolution.
- AI can materially outperform a deterministic baseline at tracing causes, synthesizing reproducible tests, or communicating incident resolution—not just summarize logs.
- Customers would pay for the product; public issue reports indicate plausible pain, not willingness to pay.
- A lasting market gap exists between PayPal's dashboard, webhook tooling, static integration checkers, and financial reconciliation. **Do not claim uniqueness or market dominance without competitor evidence.**

## 1. The company-scale mission and the focused hackathon wedge

**Mission:** For every consequential commerce action, independently prove that the intended business outcome happened, explain inconsistencies, and make safe recovery and prevention routine.

**Initial product:** PayPal-centric order outcome assurance for a controlled reference merchant, with two polished workspaces:
- **Engineering Console (first buyer):** integration health, traces, replay, race/failure diagnosis, code-facing regression evidence.
- **Operations Workspace (first-class partner):** money at risk, affected customers/orders, actions, approvals, clear case histories, customer-facing status.

**No two separate truth stores.** Both read the same incident state, domain events, and evidence with different permissions and affordances. Operations is not merely a simplified dashboard; it must let its user close a well-defined case without developer guidance.

**Core product loop:** **Observe → Detect → Investigate → Recover → Verify → Prevent.** Every feature should improve at least one transition; otherwise defer it.

**First user journey:** A genuine PayPal Sandbox payment succeeds. In our **controlled merchant code**, injected concurrency causes duplicate local orders. OrderTruth observes one validated capture and multiple unintended local orders, records a machine-verifiable discrepancy, explains candidate causes using grounded AI, allows a human-approved **local-only** correction, verifies the postcondition, and reproduces the defect in a regression test.

**Important domain nuance:** One PayPal capture is **not universally equivalent** to one merchant order. Purchase units, partial captures, authorizations, split fulfillment, legitimate retries and eventual consistency must be modeled according to the reference merchant's **explicit lifecycle contract**. We can enforce single-purchase/single-order only in our first reference scenario, where that promise is documented.

## 2. Market research and differentiation process

### Research register
Maintain `docs/RESEARCH_REGISTER.md` (public, non-sensitive, cited). For each source: URL; original author/source; observed date; first-hand report vs company claim vs promotional entry; exact claimed failure; attempted reproduction; limitation; and relevance to our product. Source types: PayPal official docs, GitHub production issue threads, merchant forums, Reddit, engineering blogs, Devpost competitors, open source alternatives. Never count multiple reposts as independent evidence.

Examples to scrutinize rather than repeat as gospel:
- WooCommerce PayPal Payments issue #4173: reports a single capture with duplicate merchant orders in a race condition: https://github.com/woocommerce/woocommerce-paypal-payments/issues/4173
- PayPal official webhook delivery/verification: https://developer.paypal.com/api/rest/webhooks/rest/
- PayPal AI hackathon competitors, including authorization guards, reconciliation assistants, and payment-integrity demonstrations. **Read repositories and demos if available; Devpost descriptions are assertions, not proof of implementation.**

### Novelty hypothesis
Existing tools address subsets: API observability; webhook delivery/retry; financial reconciliation; static checking; agent payment authorization. Our **testable distinction** is a single workflow that links **provider readback + merchant state + deterministic outcome violation + grounded competing hypotheses + safe approved repair + verified regression** for both engineering and operations.

### Kill tests for novelty
1. Implement a conventional rules-based baseline for the same incident class.
2. Inspect three competitor implementations or official capabilities, noting feature overlap precisely.
3. Show AI adds measurable utility on previously unseen or ambiguous incidents. If not, change AI role, not the measurement.
4. Ask if a merchant operator can finish the case with no engineering console open.

## 3. Prioritized scope and exclusions

### P0: prove feasibility before committing (first 24–48 hours)
- Confirm account separation (Sandbox business/seller and personal/buyer), app client ID, secret, and eligibility.
- Successfully get a **Sandbox OAuth token** (masked success metadata only).
- Server creates one **Orders v2 CAPTURE-intent** order; buyer approves it **manually** using Sandbox personal buyer; server captures with an idempotency request ID; server GET/readback confirms capture status and amount; save scrubbed evidence. A created order alone does **not** pass the gate.
- PayPal SDK v6 proof: eligible PayPal button session, create-order returns `{orderId}` (not only string), explicit approve/cancel/failure states; secret remains server-side. If v6 fails due to documented local eligibility, collect proof and evaluate current official alternative; do not silently fall back.
- Local merchant transaction persists to database with durable checkout/order identity and unique payment relations.
- AI: one actually authenticated, free service with structured output and measured quota; plus a cheaper deterministic baseline. No real source prompts containing credentials, customer PII, or raw bearer tokens.
- Time-boxed infrastructure: one-command local setup, unit tests running, no paid account, no mandatory external production hosting.
- If approval requires interaction, STOP and ask user to complete the Sandbox buyer step. Do not script password/MFA login or access a real account.

### P1: coherent vertical slice (next)
- Two merchants' views of the same **real Sandbox** transaction, persisted reference merchant business state.
- Injection of one **local merchant-side** race producing duplicate orders; captured evidence separated from synthetic injection metadata.
- Case opened by deterministic rule linked to immutable evidence. Engineer sees timeline and reproduction; operator sees impact and safe approved business action.
- Correct local-only remediation under authorization, unique action ID, dry-run preview, transaction boundary, postcondition; no silent financial API mutations.
- Re-run regression against buggy implementation (fails) and corrected reference (passes). Verify repeatability and check false positives.

### P2: extend the one coherent loop
Pick at most **two** additional incident classes after P1:
- Captured PayPal payment but no merchant order after explicitly configured grace period.
- Captured/approved payment but subscription entitlement/access not provisioned (only if a separate lifecycle scope fits and APIs are available).
- Payment capture denied/pending while merchant incorrectly ships or fulfills (high severity).
- Duplicate webhook delivery processed once correctly (must be **healthy**, not incident).
- Concurrent recovery requests or process interruption; safe retry and durable action journal.

### P3: optional, not blocking
- AG Grid sponsor-aligned analyst workbench if Community capabilities add real interaction, not as a logo checkbox; verify licensing and sponsor rules.
- User-configured alerting, external merchant integrations, historical analytics, multi-provider abstraction, organizational SaaS billing. Do not make these P1 prerequisites.

### Explicit exclusions for hackathon
Live/production payment execution; actual customer refunds or captures driven by AI; arbitrary real merchant account OAuth onboarding; broad WooCommerce plugin compatibility; claims of payment fraud detection; compliance certifications; automatic chargeback management; distributed microservices; proprietary PayPal UI/branding clone; unsafely exposed Sandbox account credentials.

## 4. Architecture: minimal, testable, growth-capable

### Initial technology choice (provisional; confirm installed tooling)
- **Language:** strict TypeScript across UI, API, and domain.
- **UI:** React + Vite or Next.js chosen on measured local simplicity; choose ONE, document decision. Accessible component primitives, CSS tokens. No expensive UI platform dependency.
- **API:** single Node.js TypeScript service with clear module boundaries, schema validation at all inputs.
- **Persistence:** SQLite for local/reference/demo with WAL, foreign keys, migrations, explicit transaction boundaries, busy-timeout behavior; avoid asserting it is ready for multi-node scale. Design database access boundary that can later migrate to Postgres.
- **Testing:** unit and integration tests, API contract tests, Playwright E2E only if browser dependency works at ₹0, race tests, restart tests, accessibility checks.
- **AI adapter:** provider-neutral interface with strict bounded context, JSON schema, timeout, retry, quota, local fixtures; use a provider **only after** verified quota and cost.
- **Deployment:** local-first reproducible build. Decide optional free hosting only after sustained access/uptime gate.

### Suggested repo boundaries
```
D:\Projects\OrderTruth\
  AGENTS.md                 # canonical instructions for Codex and Claude
  CLAUDE.md                 # Claude-specific rules, points to AGENTS.md
  agent.md                  # compatibility pointer
  .gitignore
  .env.example              # placeholders ONLY
  README.md                 # eventually public, run instructions
  docs/
    ORDERTRUTH_MASTER_PLAN.md
    ARCHITECTURE_DECISIONS.md
    RESEARCH_REGISTER.md
    API_AND_SECURITY.md
    QUALITY_GATE_MATRIX.md
    RELEASE_CHECKLIST.md
  apps/web/                 # customer-facing product and reference checkout UI
  apps/api/                 # integration/merchant/incident/recovery API
  packages/domain/         # lifecycle, invariants, shared types
  packages/paypal/         # restricted PayPal Sandbox adapter
  packages/ai/             # model interface, prompts, testable outputs
  tests/{unit,integration,e2e,faults}/
  scripts/                  # safe doctor, redact, gates
  .work/                    # IGNORE: session ledger, logs, raw sanitized? local artifacts
```
Structure is a hypothesis: do not scaffold empty directories solely to resemble it. Build as needed.

### Domain tables/concepts
- `Organization` (even single-tenant MVP carries organization ID for isolation boundary), `User`, `Membership/Role`.
- `CheckoutIntent` (currency, minor units, customer-approved business terms, merchant reference, correlation id).
- `PaymentAttempt` (PayPal order ID and capture IDs, intent, provider status, authorization vs capture distinction, timestamps and readback provenance).
- `MerchantOrder` + `Fulfillment` / `InventoryAdjustment` records, each with unique keys and actor/event causality.
- `ProviderEventInbox` (PayPal event ID unique, signature-verification result, arrival time, payload hash; never blindly trust simulation).
- `DomainEvent` append-only with trace/correlation IDs, schema version, UTC timestamps, evidence type, source.
- `InvariantEvaluation`, `Incident`, `EvidenceLink`, `Hypothesis`, `RecoveryProposal`, `Approval`, `RecoveryExecution`, `PostconditionVerification`, `RegressionCase`.

### Evidence classes visibly distinct everywhere
`PAYPAL_API_READBACK`, `PAYPAL_VERIFIED_WEBHOOK`, `MERCHANT_DB_OBSERVED`, `CONTROLLED_FAULT_INJECTION`, `AI_HYPOTHESIS`, `OPERATOR_STATEMENT`. A screenshot is not an authoritative capture record; simulated events must never be labeled genuine PayPal events.

### Lifecycles / states
- Payment checkout flow (reference merchant): `draft → created → awaiting_buyer_approval → approved → capture_in_progress → captured | denied | uncertain`. **Uncertain is not failed**: query PayPal authoritative state before retrying; capture/fulfillment must not double-act.
- Incident: `candidate → open → triaged → awaiting_approval → recovering → verifying → resolved | needs_attention | false_positive`; `reopened` transition logged. Never auto-resolve after AI text only.
- Recovery request: `proposed → dry_run_passed → approved → executing → executed → verified`, or `rejected/failed/needs_manual_review`. Separate business approval from technical execution.

### Correctness invariants for explicit first reference merchant contract
- Every checkout intent has server-authoritative amount/currency and unique immutable id.
- Provider write operations have stable idempotency keys; local order creation has a unique domain key. Retries after unknown responses read current state first.
- Webhook signature verified before business processing; event dedup by PayPal event identity; atomic inbox+effect processing or reliable outbox design.
- One approved intent for one reference product order leads to no more than one merchant order and one fulfillment under the chosen contract, except documented allowed retries/states.
- No fulfillment until a qualifying verified captured/authorized state per the reference merchant policy; no fixed unconditional assumption for all PayPal products.
- Recovery action requires right organization, role, explicit approval, idempotent action key, full audit record, and machine-verifiable postcondition.
- A failed verification cannot mutate recorded history to look successful; conflicts/timeouts remain visible.
- Order and payment status are not conflated; retries, pending events, duplicate and out-of-order webhooks, monetary precision, wrong currency, and user-cancelled approval are handled.

## 5. PayPal integration build contract

**Production is prohibited.** `PAYPAL_ENV=sandbox` is enforced at config validation; reject production API host in all development actions. Official Sandbox REST base: `https://api-m.sandbox.paypal.com`.

**Credential rules:** Client ID may be exposed only where the official SDK permits; **client secret never enters browser, source control, chat, telemetry or test fixtures**. Environment config must be validated on boot, with masked errors. Use OAuth client credentials server-side. `.env.example` contains empty placeholders. Do not include business/personal test passwords in files.

**Order operation sequence:** OAuth → server-side create v2 order → PayPal SDK v6 buyer approval → server capture POST with `PayPal-Request-Id` chosen/stored for the logical attempt → GET order/capture readback → reconcile to local intent → log sanitized provider response ID/currency/status and source. Do not treat HTTP 201/200 alone as complete if capture state is pending/partial.

**Webhooks:** Use an HTTPS endpoint only after a safe tunnel or deployment is approved and available for free. Register a Sandbox webhook ID, verify signatures using PayPal's official approach, persist dedup keys, respond appropriately and recover from retries/out-of-order delivery. Simulator events are **synthetic** and cannot prove association to genuine Sandbox captures. If HTTPS webhook reception cannot be established for ₹0, explicitly scope the first demo to readback and controlled local events; do not falsify webhook evidence.

**Negative tests:** PayPal Sandbox offers documented mock error responses for supported endpoints; confirm eligibility/headers on the official current page before use. Distinguish provider-generated Sandbox test responses from locally injected merchant faults.

**Test cards/accounts:** Prefer Sandbox buyer login in official PayPal UI; never collect real payment details or pay real money.

**Documentation to verify when coding:**
- https://developer.paypal.com/sdk/js/set-up/
- https://developer.paypal.com/checkout/integrate
- https://developer.paypal.com/api/orders/v2/
- https://developer.paypal.com/api/rest/requests/
- https://developer.paypal.com/api/rest/webhooks/rest/
- https://developer.paypal.com/negative-testing/request-headers/
- https://developer.paypal.com/sandbox-testing/overview

## 6. AI must be consequential and bounded

**Candidate responsibilities:** Explain why correlated evidence supports or rejects different failure hypotheses; propose the minimum discriminating experiment; translate confirmed technical causes into operator language; propose regression assertions. **Do not** let AI decide whether a payment captured, whether a repair is authorized, or whether a test passed.

**Structured output:** `hypothesis_id`, `claim`, `supporting_evidence_ids[]`, `contradictory_evidence_ids[]`, `missing_evidence[]`, `next_test` (allowlisted types), `operator_summary`, `confidence` (untrusted); schema validate and reject nonexistent evidence IDs. Results are explicitly hypotheses until tested.

**Evaluation:** Assemble ≥20 compact scenarios, including valid events, ambiguous pending events, actual known faulty paths and adversarial descriptions. Compare a rules-only baseline and AI on: accurate evidence citations; correct high-level diagnosis; unsupported confident statements; test usefulness; latency; token consumption; false alerts. Human-review a blinded holdout. Preset pass thresholds (initial proposal): 0 critical hallucinated financial claims, 0 autonomous financial actions, ≥80% useful supported hypotheses on selected scenarios; revise only with documented evaluation rationale, not score gaming.

**₹0 provider gate:** Record actual provider/model ID, endpoint, quota, TPM/RPM/RPD and credential condition, first 10 successful calls, estimated full-demo token cost ×3 margin, and failure behavior after 429/timeout. A successful one-off ping is insufficient. If the available free model cannot make the demo dependable, STOP and escalate; do not hide AI failure behind scripted text.

## 7. UX quality contract — independent PayPal-inspired, not PayPal clone

**Product hierarchy:** brand-independent left rail; clear Sandbox status; global search; operator persona switch or separate navigation; low cognitive load. Use licensed fonts/icons only. Avoid PayPal official wordmarks outside legitimate integration labels and official SDK components.

**Shared pages:** Overview, Incidents, Investigation, Recovery, Reliability Lab, Transactions, Integrations/Settings. Only implement a page when it has a genuine data/action path. No fake click targets or statically fabricated success charts.

**Engineering:** request ID, correlation ID, event lineage, readback provenance, compare views, replay parameters, copyable redacted regression recipe; powerful search/filter and keyboard actions.

**Operations:** money at risk (only if computed using verified state), customer/order summary, clear recommendation, concrete action permissions, impact, SLA, audit history, approved recovery and customer status; avoid raw stack traces.

**Design standards:** consistent 8px-ish spacing system and design tokens; original brand colors; semantic states + text labels; responsive desktop/tablet/mobile; WCAG 2.2 AA target (contrast, focus visible, keyboard, labels, reduced motion, screen-reader announcements); accessible charts/tables; skeletons, empty/errors, delayed states; reversible navigation, meaningful back paths, confirm destructive actions.

**Measurable UX quality targets:** common case triage ≤3 steps to evidence; an operator can identify affected order and next action without reading JSON; keyboard-complete critical workflow; target Lighthouse accessibility ≥95 in stable local checks, no critical `axe` violations; initial desktop p75 LCP <2.5s on representative hardware after measurement (not a promised result). Design tests must use real/demo-labeled data.

**Demo visual contract:** “What was promised / What PayPal proves / What merchant did / What safe fix changed / What regression now proves.” Two clear personas, shared incident, immediate outcome. Not just decorative fintech visuals.

## 8. Security, privacy, observability and resilience

- Threat model trust boundaries: browser, backend, PayPal REST, webhook endpoint, merchant DB, AI provider, local Sandbox credentials, judgment/test build.
- Validate inputs and output schemas, allowlist network origins, request timeouts, size limits, strict CORS, session/CSRF controls as applicable, rate-limit user-triggered mutation, sanitize display against XSS/injection.
- Multi-tenant boundary: org ID scoping on *every* data access and mutation; tests for cross-org attempts. No irreversible live payment operations.
- RBAC: `engineer`, `operator`, `approver`, `admin` (role matrix documented). Do not assume ops can run code/tests or engineers can authorize monetary action by default. Demo auth must be clearly marked; production auth needs separate review.
- Idempotency: API request IDs, unique DB constraints, event inbox de-dup, unique recovery action key; race and restart simulation.
- Money: currency-specific integer minor units or decimal-safe representation; no floating-point financial comparisons, no currency mixing.
- PII minimization, masked transaction/customer identifiers in screenshots; raw payloads only in ignored local evidence, with bounded retention and no source-control commit.
- Secrets: `.env`, local credentials, token traces, prompts, debug outputs excluded by `.gitignore`; secret-scan changes before authorized commits; no token printing.
- Operational metrics: PayPal request category/latency, webhook signature rejection, duplicated event count, reconciliation lag, incident false-positive rate, recovery time, AI token count/cost; use trace IDs across UI/API/test. Do not measure or log actual passwords, bearer headers or real user data.
- Failure: return honest `pending`, `unknown`, `needs_review`, `provider_unavailable` states; no “all green” default when external calls fail.

## 9. Quality gates and acceptance tests

### Gate 0 (≤48h, BLOCKS feature work)
- [ ] Repo instructions and `.gitignore` audited; user-confirmed credentials are local only.
- [ ] OAuth request authenticated in Sandbox; response recorded with sensitive content removed.
- [ ] Buyer account manually approves one genuine Sandbox order and server captures it.
- [ ] Readback records matching order ID, currency, amount and capture status.
- [ ] v6 SDK path confirmed via current official sample and browser flow.
- [ ] Database survives process restart and retains immutable intent/payment relations.
- [ ] Free model performs 10 valid bounded calls through intended adapter with measured quotas; rules-only baseline saved.
- [ ] `npm test` (or chosen equivalent) and one-command dev start function; fresh setup smoke path documented.
- [ ] User reviews gate report: GO / PIVOT / STOP, evidence paths and time/cost table. **No claim “Sandbox works” unless capture+readback was really completed.**

### Gate 1 (one end-to-end incident)
- [ ] Deterministic duplicate merchant order injection produces a real **local** state error after one genuine Sandbox capture.
- [ ] Negative control with no fault reports healthy, not an incident.
- [ ] Evidence timeline displays PayPal readback and merchant data with separate labels.
- [ ] Same incident visible in engineering and operations workspaces.
- [ ] Operator proposes and approves a local-only correction with dry-run; no silent financial write.
- [ ] Recovery action is idempotent; postcondition checks transition incident only if verified.
- [ ] Regression case fails known buggy path, passes fixed path, repeats deterministically.

### Gate 2 (security and reliability expansion)
- [ ] Add two failure classes only if Gate 1 sound.
- [ ] Duplicate, out-of-order, malformed, unverified webhook/event behavior.
- [ ] Same-key concurrent requests, kill/restart during uncertain commit, eventual-consistency grace period tests.
- [ ] Cross-organization denial and least-privilege permissions tests.
- [ ] AI holdout evaluation versus no-LLM baseline, including unsupported evidence references.
- [ ] All critical user flows keyboard accessible and automated a11y checked.

### Gate 3 (release / judge trial)
- [ ] `install → configure → start → run demo` clean Windows checkout repeatable; Linux/WSL if supported, documented honestly.
- [ ] License file chosen/approved by user, public repo sanitized, no ignored development evidence needed to run.
- [ ] Free judge access without publishing private developer secret; judge mode must remain a genuine functioning product, not static mock.
- [ ] Capture a complete 150–175 second video with genuine Sandbox evidence and clearly marked fault injection.
- [ ] Coverage of official five criteria, public URL or runnable build, setup and troubleshooting, Devpost submission screenshot and confirmation.
- [ ] Availability plan through Dec 15 and README description of limitations.

### Test design and truth table
Minimum initial scenarios: clean capture; approval cancellation; capture timeout then readback; duplicate capture request; pending capture; denied capture; duplicate delivery same event ID; out-of-order event; invalid signature; one capture/two orders; stale inventory; absent order after grace period; duplicate fulfillment; corrected merchant; recovery repeated; recovery crash midflight; wrong currency; missing evidence; cross-org request; AI cites nonexistent event. For every test define setup, injected input, authoritative oracle and pass/fail expected outcome. Use Sandbox where available and mark synthetic fault cases.

**Meaning of “10/10”:** an aspirational standard, not an attainable certification by self-report. Every claim must link to a repeatable acceptance check, targeted adversarial test and known limitation. Keep a visible quality matrix, not arbitrary scores.

## 10. Process controls — learned from Roomwise

### Roomwise failure mode to avoid
Significant infrastructure work preceded proof that full-run inference quotas, final evaluator compatibility, immutable evidence, and submission packaging would all succeed. We must **reverse the sequence**: provider access + true end-to-end transaction + judging setup, then core application, then expansion.

### Mandatory methods
- Small, vertical working increments; avoid elaborate harness, Docker-in-Docker, and unmeasured abstractions.
- For each proposed nontrivial feature: user outcome → contract → negative control → adversarial test → implementation → observed result → acceptance record.
- Preserve real failures. Do not loosen tests, re-label synthetic evidence, regenerate hashes to hide mismatches, or overwrite an earlier negative result.
- Formal decision record for architecture changes and deviations; pause on unresolved external prerequisites.
- Keep session notes and scratch logs in `.work/` (ignored) and durable non-sensitive decisions in `docs/ARCHITECTURE_DECISIONS.md`.
- Claude: read-only Git introspection permitted (`status`, `diff`, `log`). **Never commit or stage**. Codex/user/authorized Antigravity may commit after review.
- Token discipline: inspect relevant files not entire repo, record results once, reuse concise summaries, batch independent read-only inspection, subdelegate only low-risk tasks to cheaper available models with output review; do not spawn unbounded agents. Background long commands with bounded timeouts/logs only if tool supports; monitor periodically without busy polling, work on an independent task or wait when idle. Stop stale tasks.
- Always distinguish `VERIFIED`, `RECORDED_NOT_REPRODUCED`, `HYPOTHESIS`, `BLOCKED`, and `NOT_TESTED`.
- Human-facing progress updates at each meaningful boundary and approximately every 15–20 minutes during long-running work, without token-wasting narration.

## 11. Schedule, milestones and stop triggers

| Window (IST) | Work | Required exit |
|---|---|---|
| Oct 18–20 | Sandbox and free-model proof, acceptance skeleton, risk register | Gate 0 GO; if access blocked → diagnose once then PIVOT/STOP |
| Oct 21–25 | Real checkout + controlled merchant fault + detect → human-approved local repair → verify | Gate 1 completed in both personas |
| Oct 26–31 | Two additional incident types; AI vs rule baseline; safety tests | Gate 2 evidence or cut scope |
| Nov 1–6 | Complete operator/engineer journeys, UI/UX, usability/a11y hardening | No dead screens; user-facing task tests |
| Nov 7–10 | Red-team, fresh checkout, failure/reliability tests, demo rehearsal | Candidate release freeze |
| Nov 11–12 | Demo export, screenshots, licensing, public repo review, Devpost submit | Submission confirmation **before** deadline |
| Until Dec 15 | Keep judge access/build available; no secret exposure | Stable access and explicit limitations |

**Stop immediately and ask the user** if any call would use live money, paid provider, private account credentials beyond Sandbox, personal information, forbidden Git action, destructive reset, new SaaS terms requiring card, or a significant unverified API assumption.

## 12. Roles, decisions and communication

**User:** product owner, supplies local Sandbox environment credentials, manually approves buyer checkout, makes paywall/access/architecture decisions, approves commits via allowed actors, supplies feedback and update artifacts.

**Claude Code:** research/implementation/test/report under agent instructions; no commits or pushes; asks essential clarifying questions early and at genuine gates; reads `.env` only as required by runtime, never echoes values.

**Codex:** may independently inspect/red-team, implement and (only with explicit user authorization) perform commits; obeys `AGENTS.md`, consults `.work/` ledger, does not overwrite Claude's unreviewed work blindly.

**ChatGPT (product co-founder review):** evaluates safe sanitized progress summaries, challenge assumptions, adjust priorities and evaluate tradeoffs; do not send secrets/raw authenticated responses.

### Standard progress update format (to paste here)
```
ORDERTRUTH STATUS — date/time / agent
Stage / gate: ...
VERIFIED: ... (command/test/evidence file, redacted)
FAILED / BLOCKED: ... (exact safe error class)
CHANGES: files and behavior modified
TESTS: passed/failed/skipped; meaningful metrics
COST: ₹0 spent; model quotas and usage
RISKS / NEXT GO-NO-GO: ...
QUESTIONS: numbered, only if blocking
GIT: clean/dirty; NO COMMIT PERFORMED BY CLAUDE
```

## 13. Official references and source-check date

Checked 18 October 2026. Re-verify mutable API/competition docs when implementing.
- Competition overview: https://paypalaihackathon.devpost.com/
- Rules and judging: https://paypalaihackathon.devpost.com/rules
- Resources: https://paypalaihackathon.devpost.com/resources
- SDK v6: https://developer.paypal.com/sdk/js/set-up/
- Quick start: https://developer.paypal.com/checkout/integrate
- Orders v2: https://developer.paypal.com/api/orders/v2/
- API request idempotency: https://developer.paypal.com/api/rest/requests/
- Webhooks: https://developer.paypal.com/api/rest/webhooks/rest/
- Sandbox: https://developer.paypal.com/sandbox-testing/overview
- API negative testing: https://developer.paypal.com/negative-testing/request-headers/
- Public incident: https://github.com/woocommerce/woocommerce-paypal-payments/issues/4173

**This document is not authorization to spend money, use production APIs, stage changes, or run a payment capture without user participation.**
