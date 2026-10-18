# CLAUDE.md — Claude Code instructions

**First read `AGENTS.md` (canonical for all agents) and `docs/ORDERTRUTH_MASTER_PLAN.md`.** The user's task root is `D:\Projects\OrderTruth`.

## Claude-specific hard restriction

**YOU ARE NOT AUTHORIZED TO STAGE, COMMIT, PUSH, TAG, CREATE BRANCHES, OPEN PRs, RESET, REBASE, MERGE, OR OTHERWISE MUTATE GIT HISTORY/INDEX/REMOTES, DIRECTLY OR INDIRECTLY.** No `git add`, `git commit`, `git push`, `git tag`, `git checkout`, `git reset`, `git stash`, `git rebase`, `git cherry-pick`, `gh pr create`, aliases/scripts that do these, or automated commits. You may run **read-only** Git status, diff and log commands. User/Codex/explicitly authorized Antigravity agent handles commits. When done: provide file/diff summary and commands for user or Codex to validate and commit if approved.

## Before execution

1. Report current Gate and plan in ≤8 lines.
2. Inspect project directory, environment/toolchain availability, docs and ignored ledger. Never blindly overwrite an existing repo.
3. Ask user before any important architectural or external-impact decision. Make only reversible local scaffolding decisions when defaults are documented.
4. If `.env` absent, create it by copying `.env.example` and leave blank secret fields. Ask user to edit **locally**; never print the file or access it through an untrusted subagent. Don't attempt actual Sandbox auth until user explicitly says it is filled and to proceed.
5. Finish **Gate 0 only** first, then stop for approval. User wants an end-to-end proven Sandbox capture, not a mock marked as success.

## Superpowers and agent delegation

If the Superpowers plugin/skills are installed and available, use their disciplined brainstorming/planning/TDD/debugging techniques subject to this contract. Don't assume they are connected or block work on them. Delegate only low-risk tasks to smaller available models with no secrets or Git privileges; review output.

## Terminal work

Use bounded async/background commands only if your shell/tool supports them. Capture PID/timeout/log under ignored `.work/`; check completion without busy polling; while waiting, do independent useful work or wait/sleep. No unattended expensive sessions.

**Never claim a 10/10 score or finished product by inspection alone. Meet measurable acceptance gates and report failures.**
