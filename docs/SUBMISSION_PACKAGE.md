# OrderTruth submission package

Prepared 8 November 2026. Materials prepared, **not a submitted entry**. Exact source/deployment evidence lives in [the execution ledger](EXECUTION_LEDGER_PHASES_7_11.md). Historical V3 drafts are preserved separately.

## Title and pitch

**OrderTruth — prove the merchant outcome after the payment.**

A completed payment is only half the story. OrderTruth connects PayPal Sandbox evidence to merchant orders, investigates discrepancies and verifies a precisely approved merchant correction.

## Project description

**Inspiration.** A payment can complete while a merchant application creates two orders, or none. A payment dashboard alone cannot prove the merchant outcome. Engineers need evidence about competing write paths; operators need a clear, safe next action.

**What it does.** OrderTruth starts with genuine persisted PayPal Sandbox evidence and a clearly labelled reference merchant. Judges create isolated cases without credentials, introduce a controlled duplicate and detect the discrepancy. Merchant write keys, handler intervals and committed write outcomes provide independently inspectable diagnostics. Optional AI compares competing merchant mechanisms and recommends a relevant read-only diagnostic. New evidence can weaken a hypothesis; it never authorizes correction.

The operator reviews exactly which order remains active and which duplicate is locally voided. Approval binds the current session, exact plan and expiry. Execution preserves PayPal records. A receipt independently verifies one active matching merchant order and unchanged stored provider evidence, and can be reopened after reload. A second controlled case deliberately omits the merchant order: conservative detection waits five minutes and refuses a finding after contradictory or failed payment verification. It supports investigation, not automatic fulfillment.

**Implementation.** TypeScript domain logic, explicit PostgreSQL transactions and durable identities connect evidence, detection, authorization and verification. Genuine Sandbox OAuth, order creation, manual buyer approval, one capture and authoritative GET verification were exercised. Two genuine webhook events independently passed PayPal signature postback and durable processing. Vercel serves the frontend; the existing Render service runs the modular API against Neon. Same-origin sessions isolate judge cases. Operations and Engineering views share the same evidence; they are presentation choices, not separate security roles.

**AI.** Hosted Groq GPT-OSS-120B selects a comparison; deterministic code supplies validated facts, supporting/weakening evidence, citations and diagnostic scope. Gemini was also exercised during bounded qualification. All payment observations are omitted from model requests. Fixed endpoints, bounded responses, one in-flight request, durable daily/session allowances and no paid fallback constrain inference. Cached and unavailable states are explicit.

**What we learned.** Citation-valid prose alone is unsafe; facts and diagnostic relevance require independent validation. Disjoint handler intervals weaken concurrency without proving the cause. Timeouts do not prove a payment or database write rolled back. Those lessons shaped the uncertainty and recovery states.

**Evidence and limits.** Twelve concurrent local merchant journeys produced twelve independently verified receipts, including duplicate execution and cross-session refusal. This is local evidence, not hosted capacity. The final comparison pilot accepted seven of seven responses after earlier failed protocols; only three common developer-authored cases were compared. AI superiority over rules is **not established**. One observed hosted reassessment revised a hypothesis after disjoint timing evidence; it does not establish general causal accuracy.

**Prevention and next steps.** The optional Integration Lab preserves a historical synthetic guard experiment: a human-written integration passes a fixed contract and intended-defect controls. It demonstrates a prevention path, not protection of the current checkout or an AI-generated migration. Promotion requires merchant-specific writer contracts and independent qualification. Real merchant connectors, broader recovery permissions and independent AI benefit studies remain future work.

**Tools.** PayPal Sandbox Orders/Webhooks and JavaScript SDK v6; TypeScript, PostgreSQL, Better Auth, Vite, Vercel, Render, Neon, Groq GPT-OSS-120B and Google Gemini. OpenAI Codex and Claude Code assisted earlier planning, implementation and review; current execution uses Codex. The guard reference fix is human-authored, not an applied AI migration patch.

## Judge instructions

1. Open [OrderTruth](https://order-truth.vercel.app). No email, password or PayPal account is needed.
2. Choose **Inspect a payment outcome**, **Introduce duplicate**, then **Detect anomaly**. The extra order is a controlled merchant fault, not a natural PayPal delivery failure.
3. Inspect write keys or choose **Investigate with AI**. Quota/unavailable is a supported state; deterministic diagnostics and correction remain usable. Reassessment is an explicit additional request.
4. Review the exact plan, approve, execute the local repair and inspect the verified receipt. Reload or **Resume/Recheck Case** to reopen persisted state.
5. Engineering view exposes technical detail; the optional Lab is a separate historical synthetic appendix.
6. For missing-order inspection, choose **Explore another integrity case** on the overview. Wait until the displayed deadline, then check again. No fulfillment or payment action is offered.

Keep the same browser session and save the case URL. A new anonymous identity cannot take over another session's case. Owner payment access is outside the judge journey. See [local setup](POSTGRES_LOCAL.md) and [recovery](JUDGE_RECOVERY.md).

## Demonstration script

Target **2:40**; final recorded duration must be measured. Use actual functioning application footage. Never label a cached response fresh or splice synthetic input into a genuine-payment claim. No new PayPal payment is required.

| Time | Actual screen and narration |
|---|---|
| 0:00–0:20 | Workspace: “A successful payment does not prove the merchant created the right order. OrderTruth links the sources and makes the discrepancy actionable.” |
| 0:20–0:40 | Verified Sandbox receipt, then case: “We exercised one genuine USD1 Sandbox capture, authoritative readback and two authenticated webhook events. This case references persisted evidence; it does not take another payment.” |
| 0:40–1:00 | Introduce the labelled duplicate and detect: “Our controlled merchant creates a second order. Deterministic checks establish the discrepancy. PayPal did not duplicate this payment.” |
| 1:00–1:35 | Properly labelled fresh/cached investigation and diagnostic: “AI compares possible merchant mechanisms. Disjoint intervals weaken a race explanation. The cause remains a hypothesis. Payment observations are excluded from model input.” |
| 1:35–2:10 | Review, approve, execute: “The plan keeps one order and locally voids the duplicate. Approval and execution are separate. Neither the model nor this repair can capture or refund a payment.” |
| 2:10–2:35 | Reload receipt: “Independent verification finds one active matching order and unchanged stored payment evidence. The result survives reload.” |
| 2:35–2:40 | “OrderTruth makes the boundary between fact, hypothesis and permitted action visible.” |

## Publication checks

Official [rules](https://paypalaihackathon.devpost.com/rules) rechecked 8 November: deadline 12 November 2026 noon PST (13 November 01:30 IST); English materials, functional access, public open-source repository and publicly visible YouTube demonstration under three minutes. Access must remain available through judging, 15 December. GitHub public/MIT metadata verified 8 November.

Description, instructions and recording script are prepared. Final footage/audio rights review, measured video duration, public YouTube URL and actual Devpost submission are **NOT VERIFIED** here. Do not invent a URL, assert submission, accept entrant legal terms or certify personal/team eligibility on someone else's behalf. Use the reviewed final video and accurate source/release identity in the entry.
