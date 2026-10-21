> **HISTORICAL (Gate 0 starter pack, kept for the record).** Its setup steps describe the original instruction ZIP, not the current application. For setup, the demo, limits and tests, read [`README.md`](README.md). (Marked historical in Gate 3A, 2026-10-21.)

# OrderTruth starter pack — begin here

This is an **instructions-and-feasibility starter pack**, not a working application or successful Sandbox payment. Files were generated outside your Windows machine. Your required local directory is **`D:\Projects\OrderTruth`**; nothing has been remotely written there.

## How to use on Windows

1. Download `OrderTruth_Starter_Pack.zip` from this conversation.
2. Inspect `D:\Projects\OrderTruth` first. If there are existing files, **back them up / compare**, do not blindly overwrite them.
3. Extract the ZIP so that `D:\Projects\OrderTruth\AGENTS.md`, `D:\Projects\OrderTruth\CLAUDE.md`, `.gitignore`, `.env.example`, `docs\ORDERTRUTH_MASTER_PLAN.md`, and `prompts\CLAUDE_CODE_KICKOFF.md` are **direct children in the correct locations**. The ZIP has files at its root (not an extra OrderTruth directory).
4. Open PowerShell:

```powershell
Set-Location 'D:\Projects\OrderTruth'
Get-ChildItem -Force
# If .env does not exist, create from the no-secret template:
if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env' }
# Edit .env **locally**, never paste contents into chat:
notepad .env
# After saving locally, launch Claude Code in this directory:
claude
```

5. In Claude Code, paste **the full text** of `prompts/CLAUDE_CODE_KICKOFF.md` as the opening task (or tell Claude to read that file). Claude must read `AGENTS.md` and `CLAUDE.md` first.
6. Check **Sandbox Accounts** for a business seller and personal buyer. OAuth proof is not enough: real buyer approval and capture/readback are the Gate 0 target. Handle login/approval yourself in PayPal's Sandbox UI when Claude asks.
7. When Gate 0 is complete, share the **redacted** `docs/GATE0_FEASIBILITY_REPORT.md` and a concise status update with ChatGPT for the go/pivot/stop decision.

**Windows ZIP note:** `.env.example` and `.gitignore` begin with a dot. Extraction must preserve them. `.work/` is deliberately ignored by Git; local ledger contents should never appear in a public commit.

## Files
- `docs/ORDERTRUTH_MASTER_PLAN.md`: complete product thesis, staged architecture, UI/UX, PayPal Sandbox, risk, test, safety and delivery plan.
- `AGENTS.md`: shared rules for all coding agents, including irreversible Git restrictions.
- `CLAUDE.md`: Claude-specific no-commit instructions; `agent.md`: compatibility pointer.
- `prompts/CLAUDE_CODE_KICKOFF.md`: copy-paste kickoff with stop-after-Gate-0 scope.
- `.env.example`: locally populated Sandbox-only placeholders.
- `.gitignore`: hides `.env`, local db, scratch logs and `.work/` ledger.
- `.work/ledger.md`: initial ignored working context; if ZIP extraction excludes hidden files, Claude will recreate it.

## Important boundaries
- `.env` **must stay private**; do not share contents, screenshots showing the secret, token dumps, or buyer credentials.
- PayPal Dashboard sign-in and the ChatGPT PayPal connection do not prove Orders v2 Sandbox calls work.
- Claude **does not** run any Git write operation or make commits; use Codex or user/authorized Antigravity for commits only after approval.
- No live transactions, paid services, public hosting, or long-running model jobs without explicit approval.
- A normal Devpost submission requires an open-source license and public repo; the license choice and public release are deferred until the user approves them.
