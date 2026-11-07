# AGENTS.md — OrderTruth canonical agent operating rules

**Applies to:** Codex agents and subagents in OrderTruth and its assigned isolated worktrees. Only Codex agents are currently available.
**Authority:** User instructions > this file > docs plans > local working notes. Current owner decisions below supersede historical approval/gate language in older plans and audit reports. Ask only about unresolved material contradictions; do not reopen routine local permissions.
**Entry point:** Read this file, `docs/ORDERTRUTH_MASTER_PLAN.md`, `.gitignore`, and current `.work/ledger.md` if present. Read relevant phase sections and assigned audit/contract references after orientation.

**Product direction (owner decision, 7 November 2026):** Build a premium, usable, end-to-end merchant payment-integrity product. The hackathon is the first release milestone; genuine merchant usefulness and potential value to the PayPal ecosystem are long-term goals. Preserve genuine Sandbox evidence, honestly labeled controlled merchant faults, deterministic evidence-based detection, optional useful evidence-grounded AI, explicit human-authorized merchant-only recovery and independently verified persisted receipts. No separate mock/demo product mode, fake payment state, fabricated AI, decorative navigation or simulated success presented as live integration. Accurately labeled controlled Sandbox reference-merchant scenarios remain valid; isolated synthetic test fixtures are qualification inputs, never genuine payment evidence.

## 1. Non-negotiables

1. **No guessing / no pretending:** Classify all assertions as `VERIFIED`, `RECORDED_NOT_REPRODUCED`, `HYPOTHESIS`, `BLOCKED`, or `NOT_TESTED`. Attach commands, observable outputs and redacted evidence to strong claims. No fake demos, static success states, or invented metrics/URLs.
2. **Clarify material unknowns:** Ask concise numbered questions only where an unresolved answer materially affects money, authentication/security, API compliance, architecture, external services, irreversibility or judging eligibility. Ordinary reversible local engineering is preauthorized (§2); choose and record safe defaults without stalling.
3. **Communication:** Briefly announce the goal and a small executable plan; give progress updates at each gate and during long tasks (approximately every 15–20 minutes). On blocked work, say what failed, evidence, alternatives, and required user action. Keep user in the loop throughout.
4. **Budget ceiling ₹0:** Do not sign up for paid services, activate trial requiring billing, provide payment cards, provision billable compute, enable production APIs, or make real-money calls without express user approval. If a required service has no free route, stop and report it.
5. **Secrets:** All secrets local in `.env` (gitignored). Never echo, cat, summarize, screenshot, upload, print, store in agent outputs or logs, or copy secrets to Git. The browser may receive only the public client ID where official SDK permits. Never request secret values pasted into chat. Scan staged/diff content before any authorized commit.
6. **Sandbox ONLY:** PayPal API base must be `https://api-m.sandbox.paypal.com`; test buyer uses PayPal Sandbox. Fail closed if configured `live` or production host. All financial side effects require user confirmation; read-only access is preferred first.
7. **Explicit evidence boundaries:** PayPal API readback ≠ a simulated webhook ≠ merchant database ≠ AI hypothesis. Keep each label explicit in UI, tests, reports and demo. Never mark any payment captured without authoritative capture evidence.
8. **No unnecessary complexity:** Deliver one coherent vertical slice before framework/generalization. Favor a modular monolith. Every user-facing control must work and have a failure state; no placebo AI feature.
9. **Proven correctness:** Test positive, negative, duplicate, concurrent, restart, timeout, authorization, cross-org, and unexpected valid behavior. Never modify tests to manufacture a pass or infer production readiness from local tests.
10. **Production-grade direction:** Security, correctness, reliability, observability, UX, a11y, documentation, reproducibility and cost must each have measurable acceptance criteria. “10/10” is a quality ambition, not a score to self-assign.
11. **No brand confusion:** Independent OrderTruth visual brand; use PayPal's authorized SDK/buttons and proper connectivity labels, but do not copy official dashboard identity or imply PayPal endorsement.
12. **Respect the user's time:** Fail fast on dependency, quota, eligibility, environment and acceptance constraints BEFORE large feature work. Roomwise's last-mile validation failures must not recur.

## 2. Git responsibilities — mandatory for every agent

**Claude Code, including Claude subagents: NEVER perform write operations on Git state or GitHub.** This includes `git add`, `git commit`, `git push`, `git tag`, `git reset`, `git rebase`, `git cherry-pick`, `git merge`, `git stash`, `git checkout`, branch creation or deletion, `gh pr create/merge`, or scripts/tools that commit or push implicitly. Allowed: read-only `git status`, `git diff`, `git log`, `git show`, `git ls-files` (without exposing secrets). Claude can edit **ordinary working tree files** under the project after permission; it cannot stage or commit them. It ends each iteration reporting changed files and `git status --short`.

**Codex** may create commits **only after the user's explicit permission**, test validation, secret review, and diff approval. Commits, pushes, PR publication, merges and history rewrites each require express authorization for that action; commit permission does not imply permission to publish or deploy. The user may commit at any time. Never sneak Git writes through build tools or hooks. The retained Claude restriction above is a safeguard if availability changes, not a direction to use Claude.

**PREAUTHORIZED local execution:** Source inspection; coding/refactoring within assigned ownership; local dependency installation; compatible Node 22 and development tools; disposable local test databases; tests/builds/local browser launches/debugging; safe local test data; reports/screenshots; and additional isolated worktrees when needed. Implement after inspection, rather than stopping at a plan or asking routine permission. This does not authorize deleting existing data, relaxing security or exposing secrets.

**Sensitive approval boundaries:** New PayPal Sandbox capture or any other provider-side write; real-money/production financial operations; new external AI inference/quota expenditure; hosted application/database mutations; preview/production deployments or external configuration changes; credential/webhook/account administration; destructive operations on existing data; and the Git actions above. Require explicit owner approval. Production/live financial configuration still fails closed; approval is not a bypass of Sandbox-only policy. Never read secrets unnecessarily. Continue safe independent work when a sensitive step is blocked.

## 3. Persistent working memory and `.gitignore`

Use `.work/ledger.md`, `.work/blockers.md`, `.work/runs/`, `.work/metrics/` for local working-state notes and logs. They **MUST be ignored by Git**. Keep entries concise, timestamped, factual and file-referenced. Store zero secrets and minimize PII even in local ledgers. Create `.work/` if missing, but don't add large spike archives. For durable non-sensitive decisions that belong in a public repository, keep a short ADR in `docs/ARCHITECTURE_DECISIONS.md` (separate from scratch ledger). Do not create a conflicting second source of truth.

At each session: read the most recent ledger summary, assess current repo, record `last confirmed gate`, `changed files`, `tests and outcomes`, `blockers`, `next action`, `risks`, and `user approvals`. Never trust a prior agent's “passes” without inspecting evidence at relevant boundaries.

## 4. Smart execution and token economy

- Before each implementation slice: inspect affected implementation and documented contracts; verify exact source SHA and worktree diff; state user-visible acceptance criteria, affected files, risks and stop conditions; verify relevant dependency APIs and reuse existing tests rather than duplicating coverage. Then IMPLEMENT within the authorized local scope. Inspect **targeted files/ranges**, not whole-repo dumps or giant logs. Maintain a brief working index in `.work/ledger.md` so subsequent agents don't re-read everything.
- Make small, reviewable changes. Prefer deterministic tests and short commands before full builds. Batch independent checks when safe. Stop repeated failures after a bounded retry count; capture exact error classification instead of spinning.
- Parallel Codex work is an optimization, not a mandate. When independent work exists, use separate Git worktrees, non-overlapping ownership and least-privilege context. Do not concurrently edit shared files, migrations, lockfiles, app entrypoints or deployment configuration. One central release integrator reconciles changes. Individual agents run targeted tests; integration runs the complete relevant suite once per candidate plus browser tests, repeating affected checks after fixes. Do not duplicate audits, identical tests or repository indexing without a specific reason. Critical architecture, payment, auth/security, domain invariants, release and evidence integrity receive high-skill review; verify delegated output. Do not assume assistant inference is free or invent metering.
- Large terminal tasks: when CLI supports it, run bounded background jobs with explicit timeout, log path under `.work/runs/`, process ID/job ID, cleanup and failure reporting. While waiting, do useful independent inspection or testing. If there is no independent work, **wait or sleep using available tool capability rather than busy polling**. No long-running orphan processes, runaway token usage, or hidden hours-long tasks. Stop when approval is needed.
- Never let subagents read `.env`, invoke live PayPal/paid endpoints, change Git history, or approve financial actions. Use least-privilege task context; concise delegation input/output.
- Reduce duplicated explanations to the user: small checkpoints with facts, not running narration. Save repeatable commands to `docs/` and summarize results with path references.

## 5. Engineering quality standards

- Domain logic separately testable from UI and provider SDK; strict typing, input schema validation, explicit state machines, server-authoritative money amounts, integer minor units, UTC timestamps, unique constraints and idempotency keys.
- PayPal one-time Sandbox checkout must be proven via OAuth, create order, manual buyer approval, capture, GET readback; record safe status evidence. Webhook signature, event-ID dedup and HTTPS listener must be proven separately before claims of webhook support.
- For retries after uncertain external side effects, read current provider state first. Do not interpret timeout as failure. Distinguish pending/grace period from broken state. Include negative controls so rules do not accuse legitimate transactions.
- RBAC target: engineer inspects traces/replay; operator triages and initiates workflows; approver authorizes protected actions. Claim separation only with server-enforced, independently tested permissions; current view toggles do not establish RBAC. Restrict recovery to safe local reference merchant state until further approval. Never let model output trigger PayPal capture/refund or authorize repair.
- AI must have measurable performance against a no-LLM baseline and cite evidence IDs; no invented references. Bound model input, output, latency, quota and privacy. If AI unavailable, show honest unavailable status rather than a fabricated AI explanation.
- UI: independent brand inspired by good fintech usability; separate first-class engineering/operations journeys sharing an incident; responsive, WCAG 2.2 AA target, focus/keyboard contrast/reduced-motion, loading/error/empty states, verified-vs-hypothesis visual clarity, and no dead controls.
- Guided UX: a first-time user immediately understands the business problem and has one obvious functioning next action: Payment evidence → Merchant discrepancy → Investigation → Approval → Correction → Verified outcome. Put actual payment facts and merchant outcomes ahead of IDs, hashes and JSON; disclose technical diagnostics contextually. Premium responsive design must include clear recovery for session startup, Render cold start, missing evidence, limited quota, unknown outcomes, expired plans, interruptions and reload. No broken progression, dead buttons or cosmetic authorization claims.
- Tests: unit, integration, contract, e2e, concurrency, replay/restart, security, accessibility. Record skipped tests and environmental limitations clearly; do not claim production certification based on mock tests.
- Keep the official competition requirements visible. Prefer a complete three-minute truthful demo over an enormous incomplete feature list.

**Browser-led qualification:** CI, unit tests and successful builds are baseline evidence, never release approval. Use Codex's built-in browser for real interaction testing whenever available. After meaningful behavior/UI changes, exercise actual behavior, inspect console/network failures, capture desktop/mobile screenshots, correlate requests with sanitized backend logs, reproduce/debug failures and repeat complete journeys. Test refresh, timeout, concurrency, error and recovery; reopen final persisted receipts after navigation/restart where applicable. DOM mocks are not browser verification. Record exact SHA plus uncommitted diff identity, runtime, backend/database identity, evidence paths and remaining uncertainty. If the built-in browser or environment is unavailable, record BLOCKED/NOT_TESTED and use available real-browser fallback with its name and limits; never claim the missing built-in check. Synthetic browser fixtures cannot replace actual backend/database E2E or genuine Sandbox evidence.

## 6. Working rhythm / approval gates

**At the start:** State the current phase and missing essential prerequisites. If real authentication needs a missing `.env`, create a blank template from `.env.example` without copying secrets and stop only the dependent auth work until the owner fills it and says ready. Continue credential-free local implementation/testing with explicit synthetic fixtures. Never output secret contents.

The early-development Gate 0/1/2/3 schedule is historical, not a new implementation permission gate. Current sequence:

| Phase | Required outcome |
|---|---|
| P0 | Baseline, supported runtime, positively identified safe environment and real browser capability |
| P1 | Functional V2 correctness and premium guided UI |
| G1 | Independent red-team integration and real end-to-end qualification |
| P2 | Evidence-supported AI improvement and selected V3 additions |
| G2 | Independent red-team qualification of the integrated P2 candidate |
| P3 | Separately approved deployment, actual hosted browser rehearsal and Devpost readiness; judge usability through 15 December |

One independent red-team review follows each integrated development phase: reproduce defects, fix authorized local problems and rerun affected tests. It does not self-authorize release. Phase G2 above is a qualification gate, distinct from the historical G2 native Sandbox experiment.

**Dated source observations:** As inspected on 7 November 2026, A/B/C use V2 `eb39f1549b34f67f2acb67a52d87e28be62cfb1b`; D uses experimental handoff `c700db9b22e1db54fb75e917bb561dd50785c7eb`. These are observations, not permanent branch/deployment identities. Reverify each slice. Main V2 is the fallback; the experimental V3 handoff is not a validated production replacement. Read the assigned reports and `../reports/PHASE1_EXECUTION_CONTRACT.md` in this audit-worktree layout. Do not infer role separation, live historical-G2 causality, fresh PayPal verification or AI superiority. Do not import V3 wholesale or overwrite frozen/historical evidence.

## 7. Required report at every checkpoint

```
STATUS: [P0/P1/G1/P2/G2/P3; GO/AT-RISK/BLOCKED]
VERIFIED: commands and observed pass evidence (redacted)
NOT TESTED: ...
IMPLEMENTED: file paths and behavior
TESTS: passed / failed / skipped (do not conflate)
BROWSER: built-in browser evidence paths and actual journeys, or BLOCKED/NOT_TESTED
DEFECTS: important defects found/fixed and reproduction evidence
SOURCE: full SHA, worktree path/state, uncommitted diff identity, runtime, backend/database identity
RISKS: top 3 and proposed mitigation
COST / QUOTA: external actions, actual ₹ spend + inference usage; unknown metering explicit
INTEGRATION: ownership, contract dependencies and remaining risks
BLOCKING QUESTIONS: concise numbered list or none
NEXT ACTION: one small authorized action
GIT: status, changed files and authorized Git actions; no commit/push without express approval
```

## 8. Escalation and emergency stop

Immediately stop the affected operation if: accidental live API configuration; nonzero cost; secret exposed; real card required; external account change without approval; unexpected money action; inconsistent payment readback; destructive DB operation; failed sandbox integration after bounded attempts; missing official SDK capability; unknown database identity. Unverified judge access blocks release claims/promotion. Investigate bounded alternatives and continue safe independent local work; stop the whole task only for an actual sensitive approval boundary or genuine unsolved blocker with no safe work remaining. Surface evidence, alternatives and required owner action; never silently substitute a mock.

**Final rule:** A passing model-generated test is evidence only of what that test actually checked. Source of truth is independently observable behavior under the exact environment and version being shipped.
