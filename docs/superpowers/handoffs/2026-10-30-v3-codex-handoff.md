# OrderTruth v3: handoff to Codex (after Gate A)

Date: 2026-10-30. Repository `C:\projects\ordertruth`, branch `fixes`, HEAD `fc85ac3`. Owner: Prachi (with Aniruddh).
Previous builder: Claude Code, which stays on as **reviewer** (see §7). Hackathon deadline: **12 Nov 2026, noon PT = 13 Nov 01:30 IST**; judge access must keep working through 15 Dec 2026.

Read this whole file before acting. Then read `AGENTS.md` (canonical rules, binding on Codex), `docs/ORDERTRUTH_MASTER_PLAN.md` §0 and §11, and the tail of `.work/ledger.md`.

---

## 1. Where things stand

**Gate A of v3 PASSED (VERIFIED, reproduced from a clean checkout).** It is a narrow feasibility verdict for one fixed synthetic lab:
- profile P1 (`createOrderOnce`), tier T1 (registered statements), one tenant per merchant database, variant V-A (REF-BUG-1, the checkout-return vs webhook race), one human-written reference fix, synthetic TEST authority only;
- the isolated verifier showed: the original duplicates under forced interleaving (2 orders); the reference fix gives exactly one matching order under forced race and 8-process stress; crash, lost/dropped/held COMMIT, paused and restarted database never produce a second order and unknowns stay `STILL_UNKNOWN` until durable evidence decides; tenants don't collide; the test authority is refused in a normal guard and live is refused; all 9 negative controls are rejected for their intended defect; two runs match; a clean clone reproduces it.

It does **not** establish: AI value, P2/T2, consumers, ingest, legacy reconciliation, coverage, real PayPal readback, hosted deployment, production security/performance, or a verifier safe for **hostile or AI-generated** code (see §5 W2).

**Commits (all by the owner):** `82d851c` design spec · `8ad29ab` plan rev 3 · `f87f1f9` CP0 · `468d152` CP1 · `93dfa4f` CP2 · `59bcaab` CP2 timeouts · `9df2394` SQLSTATE rejections + bounded listing · `950f2b6` CP3 verifier · `fc85ac3` verifier fixes. Local branch is ahead of `origin/fixes`; nothing v3 has been pushed unless the owner did so since.

**Untracked, not ours, never touch:** `cold-start-review.txt`, `docs/TEAMMATE_HANDOFF.md`.

## 2. Documents and evidence

| What | Where |
|---|---|
| v3 design spec (contracts; §5 SDK, §6 capabilities, §9 Migration Agent, §10 verifier, §13 hosted lab view, §15 build order, §19 gates) | `docs/superpowers/specs/2026-10-30-ordertruth-obligation-integrity-design.md` |
| Gate A plan, revision 3 (frozen) | `docs/superpowers/plans/2026-10-30-ordertruth-v3-gate-a.md` |
| **Gate A result** (11 criteria, hashes, limitations) | `.work/v3/gate-a/GATE_A_RESULT.md` |
| Reproducibility record | `.work/v3/gate-a/REPRODUCIBILITY.md` |
| Checkpoint reports (what was built, reviews, deviations, limitations) | `.work/v3/gate-a/checkpoint-{1,2,3}/REPORT.md`, `.work/runs/cp3-verifier-fixes/REPORT.md` |
| Passing verifier runs | `.work/v3/gate-a/gate-a-2026-10-30T15-09-27-597Z/` (original) and `.work/v3/gate-a/checkpoint-4/reproduction-evidence/` (clean-clone copy) |
| Working memory | `.work/ledger.md` (append-only, factual, no secrets) |

`.work/` is git-ignored: it exists only on this machine. A cloud or fresh-clone Codex session won't see it; ask the owner for copies if you run elsewhere.

**Identity of the accepted build:** manifest `b9e880ee0970c0bd0fb4bbd63086dc86beab1e179690fb4fe52f594309e44f72` (56 pinned files), guard tree `7bef5fc5e0c5eaa5ac9bdcf16f6fa7c8bca86f5df83637d2e3c80f4e61f70f42`.

## 3. Code map (v3 only; v2 lives in `src/`, `web/`, `tests/**` and must not change unless a work stream says so)

- `packages/guard/` — the SDK slice. `sql/guard-v1.sql` (migration), `src/identity.ts` (key encoding, fingerprints, event IDs), `src/config.ts` (registered-statement validation), `src/schema.ts` (`migrateGuard`), `src/capability.ts` (HMAC capabilities, `issueCapability`), `src/commit.ts` (`runGuardTx`, `resolveCall`, `recoverPending`: the §5.3e unknown-commit protocol), `src/guard.ts` (`createGuard`, `createOrderOnce`, `resolve`, `recoverPending`), `src/index.ts` (production entry; never imports `./testing`), `src/testing/` (TEST authority), `fixtures/synthetic-fixture.json` (`SYN-` IDs only).
- `packages/lab-merchant/` — the lab shop: `schema.ts`, `v-a/{original,reference-fix,ordertruth.config}.ts`, `nc/*` (nine one-defect negative controls), `candidate-main.ts` (one command → one JSON claim line).
- `packages/verifier/` — trusted verifier: `src/{report,observer,barrier,rungs,controller-main,manifest,proxy,proxy-main,trusted-db,cleanup}.ts`, `sql/roles.sql`, `docker/{base.Dockerfile,proxy.Dockerfile,gate-a.compose.yml,l0-in-container.sh}`, `verifier-manifest.json`.
- Tests: `tests/v3/*.test.ts` (offline; picked up by CI's `pnpm test`, must open no sockets), `tests/v3-postgres/*.integration.ts` (PostgreSQL 18; **not** run by CI).

## 4. Hard rules (summarised; `AGENTS.md` wins on any conflict)

1. **Git:** don't commit, push, tag, branch, reset or rebase unless the owner explicitly permits that specific action. Commits go out under the owner's own git identity; **no `Co-Authored-By` or other agent trailers**. Never force-push. Report `git status --short` and a commit command list at each checkpoint instead.
2. **Secrets:** never read, print, summarise or copy `.env` or `.env.*`. Never use `AI_API_KEY2` (only `AI_API_KEY`, and only when a live AI call is explicitly authorized). Never read `C:\projects\ordertruth-holdout\` contents.
3. **₹0 budget; Sandbox only.** No paid services, no live PayPal, no model calls without explicit per-run authorization. No deployment unless authorized.
4. **Evidence labels:** classify claims `VERIFIED` / `RECORDED_NOT_REPRODUCED` / `HYPOTHESIS` / `BLOCKED` / `NOT_TESTED`. The synthetic lab and the genuine PayPal Sandbox flow are always labelled separately (spec §13), in UI, README, demo and Devpost text.
5. **Test-first** for every behaviour change: write the test, run it and see it fail for the intended reason, implement, see it pass. Never weaken a test to get a pass. Run a deliberate mutation for each important check where practical.
6. **Supported runtime is Node 22.18.0 in containers.** Host Node 24.11.0 is development signal only.
7. **Scope:** stay inside the authorized work stream. Anything else is a reported follow-up, not a silent change.
8. **Every checkpoint ends with an independent review** (§7) before the next starts.

## 5. Remaining work, in recommended order

The order balances the 12 Nov deadline (≈13 days) against value. Each stream needs the owner's explicit authorization before it starts, and its own short plan (save under `docs/superpowers/plans/`). Estimates are planning guesses, not commitments.

### W1. Publish Gate A in the product: Integration Lab view (spec §13, §15 step 7) — about 1.5–2 days
**Why first:** it is the judge-visible proof of v3 and it reuses evidence that already exists.
- An **assurance record builder**: from a verifier run, produce a Proof of Protection record (variant, candidate, rung statuses, NC outcomes, manifest and subject hashes, image digests, limitations). Records go to `docs/evidence/lab/` with `docs/evidence/lab/manifest.json` (each report's SHA-256, the source commit S, the run ID, image digests).
- A **read-only "Integration Lab" view** in the existing web build, within the judge design system. The build embeds the manifest's hashes and **fails** if any record doesn't match. The page says "verified at source commit S (run Y); published in build commit P", shows the ladder, each NC, the tier and the limitations, and carries the §13 labelling: *"Reference integration, verified offline in an isolated container, using a synthetic PayPal-shaped fixture (no PayPal data). Separate from your judge case, which uses a genuine PayPal Sandbox observation."* No endpoint executes, applies or verifies code.
- **CI** (optional, needs authorization; free on a public GitHub repo): a job that runs `pnpm v3:verify:gate-a` against commit S and uploads the reports. If CI isn't authorized, publish the locally verified run and say so on the page.
- **Acceptance:** build fails on a tampered record (test); the page renders the real Gate A records; keyboard/a11y basics; no change to the existing judge flow; existing `pnpm test`, typecheck and build stay green.
- **Touches v2 surfaces** (`web/**`, build config): needs explicit authorization, because Gate A forbade v2 changes.

### W2. Verifier hardening for untrusted candidates — about 1–2 days. **Prerequisite for any AI-generated candidate (W3).**
The Gate A verifier is sound for fixed lab code only. Close, test-first, with negative controls proving each:
- **Candidate write privileges:** today `ot_candidate` has INSERT/UPDATE on shop and guard tables, so a hostile candidate can hide a duplicate (e.g. rewrite `intent_id`) or forge journals/markers. Options: column-level privileges, guard tables written only through SECURITY DEFINER functions owned by a trusted role, or append-only triggers owned by `ot_setup`. Add NCs that try each forgery.
- **Per-candidate isolation:** a fresh candidate container per candidate (not one shared container), and an exec timeout that kills the whole in-container process tree, not just the docker CLI. Keep verifier sources out of the candidate image.
- **REJECTION_AUDIT** as a separately fault-injected unknown-commit boundary.
- **Small notes:** derive NC6/NC9 claim codes from observer state, not candidate stdout; pin `tests/v3/**` by glob, not a list; a fresh clone briefly allows PUBLIC CONNECT before its `connect` section (harmless today, close it anyway).
- **Acceptance:** two full verifier runs VALID, accepted and identical; the manifest regenerated; the new NCs all `REJECTED_AS_INTENDED`; a clean-clone reproduction if the owner wants Gate A re-certified on the hardened verifier.

### W3. Gate B: AI migration value (spec §9, §15 steps 8–9, §19) — several days; may honestly end in NO-GO or a tie
Strict order (spec §9 "Ordering"):
1. **Plan** Gate B (writing-plans discipline) and get it reviewed.
2. **Development variants** V-B (service layer) and V-C (queue worker), with reference fixes, verified by the hardened verifier.
3. **Held-out variants written by someone other than the agent's implementer** (Aniruddh as custodian, per `docs/TEAMMATE_HANDOFF.md` discipline), **frozen and hashed before any agent prompt work**. Codex must never see their contents.
4. **Baselines:** B1 (ts-morph static discovery of order-table writes) and B2 (deterministic codemod wrapping B1's sites in `*Once`), given the same context as the agent.
5. **Migration Agent** (`ordertruth migrate` CLI) plus its deterministic **policy gate** (allowlisted files only; no test/harness/contract/oracle changes; no dependencies, `fetch` or PayPal calls; size limit; parses and typechecks). Develop offline only, with **mocked model output**.
6. **Preregistration**, frozen by hash: corpus, primary outcome (A vs B2 verifier acceptance on held-out variants), invalid/infra handling, repetitions, call/token budget, stop rules.
7. **Live evaluation only under its own explicit authorization** (Gemini free tier, `AI_API_KEY` only, call cap, guarded fetch pattern in `src/ai/investigator-eval/guard.ts`).
- **Honest outcomes:** no AI-superiority claim unless A beats both B1 and B2 on the frozen held-out set; a tie means "the agent matched a codemod; the guarantee comes from the SDK and the verifier".
- If time runs short before 12 Nov, stop after step 5 with an honest status, rather than rushing the evaluation.

### W4. Submission materials — about 1–2 days, can overlap W1–W3
README, demo video script and Devpost text keeping the §13 split (synthetic lab vs genuine Sandbox flow); reproducible `pnpm v3:verify:gate-a` instructions; limitations stated plainly. v2 hosted-release qualification is a separate owner track (see `docs/TEAMMATE_HANDOFF.md`); coordinate, don't take it over.

### Deferred past the hackathon (do not start without a new authorization)
P2 `markPaidOnce`, T2 callbacks, `consume`/`handleOnce`, cloud ingest and heartbeat, legacy reconciliation, coverage, the broad adoption lifecycle (spec §15 steps 2–3).

## 6. Environment facts and gotchas (learned the hard way)

- **Install:** pnpm 11.4.0 via corepack, `pnpm install --frozen-lockfile` only. No lockfile change, no new dependencies without authorization. `packages/*` have no `package.json`.
- **Docker:** Docker Desktop, WSL2 engine, data on `E:\DockerDesktop`. It has crashed once mid-build (`rpc error ... EOF`); if so, restart Docker Desktop and rerun. Compose `start` refuses while a dependency's health check recovers (use `up -d --no-deps`); a paused PostgreSQL fails its health check.
- **Commands:**
  - `pnpm exec tsc --noEmit` and `pnpm exec tsc --noEmit -p packages/tsconfig.json` (both must be clean);
  - `pnpm exec vitest run tests/v3` (offline);
  - `pnpm v3:qualify checkpoint-N` (Node 22.18.0 + PostgreSQL 18 container: packages typecheck, offline v3 and all `tests/v3-postgres`; about 3 minutes; always tears down);
  - `pnpm v3:verify:gate-a` (full isolated verifier, 2 runs, about 10–12 minutes; refuses on manifest drift; exits non-zero unless both runs are valid, accepted and identical **and** cleanup leaves nothing behind);
  - after changing **any** manifest-pinned file: `pnpm exec tsx packages/verifier/src/manifest.ts --write`, then rerun the verifier; `--expect-manifest <sha>` anchors a run explicitly;
  - full host suite `pnpm test` (expect 1099 now).
- **Vitest 5** writes an API token under the XDG data home (read-only containers need `XDG_DATA_HOME` under `/tmp`) and supports `--configLoader runner`.
- **pg:** registered statements run with `queryMode: "extended"`; pg's default connection timeout is infinite, so every pool needs one; server-side timeouts don't fire on a paused server, so trusted code needs client-side deadlines that destroy the connection (`packages/verifier/src/trusted-db.ts`).
- **Statement errors policy:** only allowlisted integrity SQLSTATEs (23502, 23503, 23505, 23514, 23P01) from `createOrder`/`orderLocator` become `REJECTED / REGISTERED_STATEMENT_ERROR` with `{statement, sqlstate}` evidence; transient codes stay retryable; anything else is rethrown.
- **Windows:** `.sh` files need LF inside images (the Dockerfiles normalise them); capture `$LASTEXITCODE` on the same line as the command.

## 7. Review protocol (Claude Code reviews; the owner relays)

At the end of every checkpoint, stop and produce the `AGENTS.md` §7 report, plus:
- **Files changed** (`git status --short` and `git diff --stat`), and the exact `git add` / `git commit` commands for the owner;
- **Commands run** with their observed results (test counts, exit codes), and evidence paths with SHA-256 for any report or log the claim rests on;
- **Tests-first evidence:** which tests failed first and why, and any mutation checks;
- **Deviations** from the plan/spec, each with a reason, and **limitations / NOT_TESTED**;
- **What you want the reviewer to look at hardest.**

Save it as `.work/v3/<stream>/<checkpoint>/REPORT.md`. The owner sends Claude the report path (or its text), and Claude reviews read-only: it reruns typechecks/tests/qualify where useful, probes for false passes, and returns PASS / PASS WITH FIXES / FAIL with numbered findings. Fix blocking findings test-first, then ask for a recheck. A checkpoint isn't done until its review is PASS and the owner has committed it.

## 8. First actions for Codex

1. Read this file, `AGENTS.md`, the ledger tail, `.work/v3/gate-a/GATE_A_RESULT.md`.
2. Verify the starting state yourself: HEAD `fc85ac3`, `git status --short` shows only the two untracked files; both typechecks clean; `pnpm exec vitest run tests/v3` 229/229; manifest drift empty (`pnpm exec vitest run tests/v3/manifest.test.ts`).
3. Report the gate and plan in ≤8 lines, and ask the owner which stream to authorize first (recommendation: W1, then W2, then W3, with W4 alongside).
4. For the authorized stream, write its short plan, have it reviewed, and only then build.
