# AGENTS.md — OrderTruth canonical agent operating rules

**Applies to:** Claude Code, OpenAI Codex, Google Antigravity agents, and subagents operating on `D:\Projects\OrderTruth`.  
**Authority:** User instructions > this file > docs plans > local working notes. If contradictory or missing rules, **stop and ask**, do not invent an interpretation.  
**Entry point:** Read this file, `docs/ORDERTRUTH_MASTER_PLAN.md`, `CLAUDE.md` if operating as Claude, `.gitignore`, and current `.work/ledger.md` if present. Read only the sections relevant to the current phase after first orientation.

## 1. Non-negotiables

1. **No guessing / no pretending:** Classify all assertions as `VERIFIED`, `RECORDED_NOT_REPRODUCED`, `HYPOTHESIS`, `BLOCKED`, or `NOT_TESTED`. Attach commands, observable outputs and redacted evidence to strong claims. No fake demos, static success states, or invented metrics/URLs.
2. **Clarify material unknowns:** Ask concise numbered questions where the missing answer affects money, authentication, API compliance, architecture, external services, irreversibility, judging eligibility, or security. For reversible local decisions, propose a default with a reason and record it; don't stall over trivial cosmetics.
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

**Codex or a user-approved Google Antigravity agent** may create commits **only after the user's explicit permission**, test validation, secret review, and diff approval. The user may commit at any time. No agent may rewrite or force-push Git history without separate explicit approval. Never sneak commits through build tools or hooks.

## 3. Persistent working memory and `.gitignore`

Use `.work/ledger.md`, `.work/blockers.md`, `.work/runs/`, `.work/metrics/` for local working-state notes and logs. They **MUST be ignored by Git**. Keep entries concise, timestamped, factual and file-referenced. Store zero secrets and minimize PII even in local ledgers. Create `.work/` if missing, but don't add large spike archives. For durable non-sensitive decisions that belong in a public repository, keep a short ADR in `docs/ARCHITECTURE_DECISIONS.md` (separate from scratch ledger). Do not create a conflicting second source of truth.

At each session: read the most recent ledger summary, assess current repo, record `last confirmed gate`, `changed files`, `tests and outcomes`, `blockers`, `next action`, `risks`, and `user approvals`. Never trust a prior agent's “passes” without inspecting evidence at relevant boundaries.

## 4. Smart execution and token economy

- Before coding: locate existing implementation, verify dependency APIs and tests, define acceptance and stop conditions. Inspect **targeted files/ranges**, not whole-repo dumps or giant logs. Maintain a brief working index in `.work/ledger.md` so subsequent agents don't re-read everything.
- Make small, reviewable changes. Prefer deterministic tests and short commands before full builds. Batch independent checks when safe. Stop repeated failures after a bounded retry count; capture exact error classification instead of spinning.
- Use lower-cost / smaller available models or subagents for low-risk tasks (file indexing, formatting, summarizing known docs, repetitive test data enumeration, simple UI text), **if the environment actually supports it and total cost fits ₹0**. Never claim delegation happened when unavailable. Critical architecture, money-related side effects, auth/security, domain invariants, release and evidence integrity receive high-skill review. Verify delegated output before trusting it.
- Large terminal tasks: when CLI supports it, run bounded background jobs with explicit timeout, log path under `.work/runs/`, process ID/job ID, cleanup and failure reporting. While waiting, do useful independent inspection or testing. If there is no independent work, **wait or sleep using available tool capability rather than busy polling**. No long-running orphan processes, runaway token usage, or hidden hours-long tasks. Stop when approval is needed.
- Never let subagents read `.env`, invoke live PayPal/paid endpoints, change Git history, or approve financial actions. Use least-privilege task context; concise delegation input/output.
- Reduce duplicated explanations to the user: small checkpoints with facts, not running narration. Save repeatable commands to `docs/` and summarize results with path references.

## 5. Engineering quality standards

- Domain logic separately testable from UI and provider SDK; strict typing, input schema validation, explicit state machines, server-authoritative money amounts, integer minor units, UTC timestamps, unique constraints and idempotency keys.
- PayPal one-time Sandbox checkout must be proven via OAuth, create order, manual buyer approval, capture, GET readback; record safe status evidence. Webhook signature, event-ID dedup and HTTPS listener must be proven separately before claims of webhook support.
- For retries after uncertain external side effects, read current provider state first. Do not interpret timeout as failure. Distinguish pending/grace period from broken state. Include negative controls so rules do not accuse legitimate transactions.
- RBAC separation: engineer can inspect traces/replay; operator can triage and initiate approved business workflows; approver can authorize protected actions. Restrict recovery to safe local reference merchant state until further approval. Never let model output trigger PayPal capture/refund.
- AI must have measurable performance against a no-LLM baseline and cite evidence IDs; no invented references. Bound model input, output, latency, quota and privacy. If AI unavailable, show honest unavailable status rather than a fabricated AI explanation.
- UI: independent brand inspired by good fintech usability; separate first-class engineering/operations journeys sharing an incident; responsive, WCAG 2.2 AA target, focus/keyboard contrast/reduced-motion, loading/error/empty states, verified-vs-hypothesis visual clarity, and no dead controls.
- Tests: unit, integration, contract, e2e, concurrency, replay/restart, security, accessibility. Record skipped tests and environmental limitations clearly; do not claim production certification based on mock tests.
- Keep the official competition requirements visible. Prefer a complete three-minute truthful demo over an enormous incomplete feature list.

## 6. Working rhythm / approval gates

**At the start:** Say which gate you're executing and ask only the missing essential questions. If `.env` absent, create from `.env.example` with blanks and stop **before auth** until user fills it and says ready. Don't output its contents.

**Gate 0 (first 24–48h):** verify Sandbox access and real approved capture/readback; verify a ₹0 AI provider's end-to-end quota; prove clean local test startup; write a concise GO/PIVOT/STOP report. **DO NOT begin full product features until the user explicitly approves Gate 0 results.**

**Gate 1:** one genuine Sandbox checkout plus controlled merchant duplicate-order fault, deterministic incident, evidence, two role journeys, local human-approved repair, postcondition and regression evidence.

**Gate 2:** only after Gate 1: two more incident classes, AI versus baseline, webhook/restart/security hardening.

**Gate 3:** polish all interactions, security and accessibility audit, clean setup, deployment/judge-access decision, public repo license and demo. Include mandatory judge usability through December 15.

## 7. Required report at every checkpoint

```
STATUS: [Gate N; GO/AT-RISK/BLOCKED]
VERIFIED: commands and observed pass evidence (redacted)
NOT TESTED: ...
IMPLEMENTED: file paths and behavior
TESTS: passed / failed / skipped (do not conflate)
RISKS: top 3 and proposed mitigation
COST / QUOTA: actual ₹ spend + inference usage
BLOCKING QUESTIONS: concise numbered list or none
NEXT ACTION: one small authorized action
GIT: status only; CLAUDE MADE NO GIT COMMITS
```

## 8. Escalation and emergency stop

Immediately stop if: accidental live API configuration; nonzero cost; secret exposed; real card required; external account change without approval; unexpected money action; inconsistent payment readback; destructive DB operation; failed sandbox integration after bounded attempts; missing official SDK capability; unverified judge access. Surface an actionable root-cause investigation, not a silently substituted mock.

**Final rule:** A passing model-generated test is evidence only of what that test actually checked. Source of truth is independently observable behavior under the exact environment and version being shipped.
