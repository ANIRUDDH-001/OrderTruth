# Gate 3A — Console correctness and judge-ready foundation

STATUS: **Gate 3A; GO for the scoped local console and judge path. AT-RISK for submission** (license, hosting, video and AI evaluation are open; see §8).

- Date: 21 October 2026 (IST). Starting main: `4f8adb0`, tree clean.
- Environment: Windows 11, Node `v22.18.0`, pnpm `11.4.0`. No new dependency.
- Statuses used: **VERIFIED** (observed in this run), **RECORDED_NOT_REPRODUCED** (earlier evidence, not rerun), **BLOCKED**, **NOT_TESTED**.
- Evidence lives under `.work/runs/gate3a/`, which is git-ignored.
- No Git command of any kind was run by Claude. No commit, stage, branch or status.

## 1. Changed files

| File | Change |
|---|---|
| `web/console/model.ts` | `verdict()` headline and notes. Grace status comes from the stored `dueAt`/`graceMs`; `graceLabel()` replaces the hardcoded "5 minute". Captured value counts only readback-confirmed captures. `missingNow()` for late orders. Strict `scopeFromUrl()`. |
| `web/console/main.ts` | Overview uses `verdict()` and states that it does not run the checker. Waiting rows show grace phases. Missing-order text depends on the latest check and on provider trust. Wording now says "stored readbacks, not re-read here". Duplicate "Paid by buyer" text is conditional. The link scope is adopted from `?org=` and an invalid scope renders a scope error page. |
| `web/console/style.css` | Styles for verdict notes and the overdue row. |
| `src/merchant/console-demo.ts` | `preflightDemoRecheck()` runs before any write or migration. The recheck refuses if the file changed between preflight and open. The report line now uses the default grace constant. |
| `src/merchant/console-static.ts` | The legacy `/investigation/:id` redirect keeps a valid `org`; a malformed or repeated org gets 400. |
| `tests/gate3a-console-correctness.test.ts` | **New**, 23 tests covering A–D and the captured-value claim. |
| `tests/gate2d-serving.test.ts` | One expectation updated: the redirect now carries `&org=org_reference` (a Gate 3A spec change, with a comment). |
| `README.md` | **New** judge-facing README. |
| `README_START_HERE.md` | Marked historical; points to README.md. |
| `docs/RELEASE_CHECKLIST.md`, `docs/QUALITY_GATE_MATRIX.md` | Gate 3A status updates. |
| `docs/GATE3A_RESULTS.md` | This file. |

Git-ignored local files: `.claude/launch.json` (preview server entries) and `.work/runs/gate3a/**` (evidence and scratch).

## 2. Mandatory defects: RED → GREEN

**RED:** baseline `pnpm check` gave 562/562 (25 files). The new suite against the unmodified code gave **22 failed / 1 passed (23)**. Evidence: `01-baseline-check.txt` and `03-red-tests.txt`.

**GREEN:** the final full suite gave **585/585 (26 files)**, typecheck 0, build 0. Evidence: `05-green-check.txt`, `06-green-build.txt` and `07/08-final-*.txt`.

| Defect | RED evidence | Fix | GREEN evidence | Status |
|---|---|---|---|---|
| **A. False all-clear.** The Overview said "Every checked payment matches its order." with 1 of 3 matched, 1 waiting past its deadline and 1 unpaid. It also said "Nothing needs attention." | Browser on a NEW synthetic DB (`red/A-false-all-clear.jpg`, `red/A-B-no-incidents-overview.txt`). The same happened with 0 of 1 matched on the short-grace DB. 5 unit tests failed. | `verdict()` with fixed precedence. The all-clear appears only when every checked checkout matched. Notes list the overdue, inside-grace, unclear, unpaid, unconfirmed and resolved cases. Contradictory records produce "Rule checks and incidents disagree." | Headline "No open incidents, but 1 payment is overdue for a re-check." plus notes (`green/A-B-overview-overdue.jpg`). 5 unit tests pass. | VERIFIED |
| **B. Misleading grace.** The page said "Paid, inside the 5 minute grace" when the deadline had passed and the stored grace was 2 min. A late-order incident said "The store has no order" while the order panel showed 1 order. | `red/B-late-order-and-short-grace.txt`, `red/B-late-order-incident.jpg`. 4 unit tests failed. | `graceStatus()` gives inside, overdue (not re-checked) or re-checked after the deadline, from the stored `dueAt`/`graceMs`. `missingNow()` gives late_order, still_missing or recheck. The headline becomes "Order arrived late. Incident kept open." The incident is never auto-resolved. No "5 minute" literal remains in the console source; a test enforces this. | `green/browser-green.txt`, `green/B-late-order-incident.jpg`. 4 unit tests pass. | VERIFIED |
| **C. Unsafe demo recheck.** `--recheck` opened (and so migrated) any file before checking that it was a demo DB. | 9 child-process tests failed: foreign SQLite modified, empty DB passed vacuously, malformed file/directory/truncated header created side files, mixed or wrong-schema DBs accepted. | `preflightDemoRecheck()` runs before the first write. It checks, in order: protected path (resolved and realpath, case-insensitive), regular file, SQLite header, wal/shm consistency, an immutable read-only open (no side files), `quick_check`, required tables, exact schema version, ≥1 intent, demo-only intents, IDs and evidence, and no webhook deliveries. Then it checks that the file is unchanged before `new Store`. | 9 child-process tests pass. A foreign DB stays byte-identical with no -wal. The judge-journey recheck on a genuine demo DB succeeded (§4). | VERIFIED (child-process tests and judge run; symlink alias NOT_TESTED, see §6) |
| **D. Org lost from legacy links.** `/investigation/<id>?org=org_other` redirected without the org, so the incident opened in the default scope. | 4 tests failed. Browser: the redirect dropped the org. | The redirect keeps a valid org and returns 400 (CSP shell) for a malformed, empty, repeated, traversal or too-long org. A wrong ID returns 404. The console reads `?org=` strictly: none, valid (adopted and persisted) or invalid (scope error page, 0 API requests). | Browser: redirect → `?lens=eng&org=org_other`, the scope rail and localStorage show `org_other`, the scope survives a reload, and a cross-org read shows "No incident … exists in org_other". `?org=ORG_bad` shows the scope error with 0 `/api/` requests. 4 tests pass. | VERIFIED |

## 3. Truth-claim review (Section 2)

Fixed, VERIFIED by tests and the browser:

- "Captured value checked" summed local attempt state. It now counts only captures confirmed by a stored PayPal readback and reports unconfirmed ones. Test: a capture whose newer readback is REFUNDED is excluded.
- The ribbon said a capture was "unchanged". It now says "in stored readbacks, not re-read here".
- "confirmed by PayPal" was unconditional. It now depends on provider trust: "in a stored PayPal readback", or "PayPal evidence unavailable or inconsistent".
- The duplicate panel's "Paid by buyer … once" now reads "one capture, per stored readback" when trust allows it.
- The hardcoded 5-minute grace in the console, the contract panel and the demo's report line now uses the stored or default constant.
- The Incidents empty state claimed every payment matched. It now points to Checkouts for waiting, overdue, undecided and uncaptured payments.

Recorded, not changed (low risk; for a later polish gate):

- The incident list keeps the title "Paid, but no order" for a missing-order incident whose order later arrived. The detail page says "Order arrived late. Incident kept open."
- The timeline node "Grace period ended · Still no order" is true at the time it marks.
- The duplicate lede "The buyer paid $X once" relies on the single stored capture. The ribbon carries the readback qualifier.
- The org scope is a development header, not authentication. This is disclosed in the UI and the README.

## 4. Judge journey on a NEW synthetic DB (Section 3)

All steps ran in a clean export at `scratchpad/export/OrderTruth`, which is outside the repository. Logs are copied to `.work/runs/gate3a/judge/`.

| # | Step | Result | Status |
|---|---|---|---|
| 1 | Clean export | Copied with the `.gitignore` rules applied (no `.env`, `.work`, `dist`, `node_modules` or DBs). 131 files; `.env.example` is the only env file. Git was not used, so this approximates `git archive`. | VERIFIED (approximation) |
| 2 | Install | `pnpm install --frozen-lockfile --offline`: exit 0, 112 packages from the local pnpm store, 5.5 s. Online install from an empty store: NOT_TESTED. | VERIFIED |
| 3 | Typecheck and tests | `pnpm check` in the export: **585/585, 26 files**, exit 0. | VERIFIED |
| 4 | Build | `pnpm build` in the export: exit 0. | VERIFIED |
| 5 | Seed | `pnpm console:demo --out .work/judge/judge.sqlite`: VIOLATED 3, HOLDS 3, OUT_OF_SCOPE 1, NOT_ELIGIBLE 1; 3 incidents. | VERIFIED |
| 6 | Launch | `pnpm incidents --db … --port 3021`, on 127.0.0.1. | VERIFIED |
| 7 | Navigate | Overview ("3 payments need attention.", with 1 inside grace and 1 not captured), Incidents (3 open), Checkouts (8), the duplicate incident in the Operations and Engineering lenses. | VERIFIED |
| 8 | Missing-order boundary | After the deadline, before any recheck, the Overview said "1 payment passed the grace deadline after the last check", "1 past deadline, not re-checked" and "Deadline passed, not re-checked". `--recheck` passed preflight and opened a missing-order incident. Its page said "…when the 5 min grace period ended at 11:16:13. The latest check still found no order." | VERIFIED |
| 9 | Duplicate recovery | `repair plan` (real CLI) succeeded. `repair approve` without a TTY was refused ("No approval was inferred"). Approval then went through `simulated-approve.ts` → `approval_mode SIMULATED_TEST`, operator "SIMULATED_TEST fixture (not a human)". **This is not a human approval.** `repair execute` (real CLI): SUCCEEDED, provider hashes before and after identical. | VERIFIED (approval simulated and labelled) |
| 10 | Receipt | "Resolved and re-checked"; "Re-check: HOLDS, 1 live order"; "Stored PayPal evidence is byte-identical before and after"; "Approved by SIMULATED_TEST fixture (not a human) (declared, simulated in a test)". | VERIFIED |
| 11 | Restart persistence | After stopping and starting the server: Open 3, Resolved 1, All 4, and the repaired incident still Resolved. The legacy link kept its org. | VERIFIED |
| — | Screenshots | Desktop 1440×900: overview, duplicate Ops and Eng. Narrow pane: receipt, overdue state, missing order. Mobile 375×812: overview, `scrollWidth == innerWidth == 375`. | VERIFIED |

Empty and error states, VERIFIED on a NEW empty migrated DB:

- Overview: "No checkouts have been checked yet".
- Incidents shows 0/0/0 with the non-all-clear text; Checkouts says "No checkouts in this group."
- An unknown page shows "Nothing here".
- An unknown incident shows "No incident INC-000000 exists in org_reference".
- With the API stopped: "The incident API is not reachable … never shows sample data".

## 5. Security and hygiene checks

- Secret scan of the clean export (pattern scan: Anthropic/OpenAI/AWS/GitHub/Slack keys, private keys, PayPal access tokens, filled credential variables):
  - 2 hits, both deliberate test fixtures: `tests/fake-paypal.ts:79` (a literal fake token) and `tests/redact-money-verify.test.ts:8` (redaction test input).
  - `.env.example` secret fields are blank.
  - **0 real secrets.** VERIFIED.
- Artifacts: no `.env`, `*.sqlite`, `*.db`, key or log files in the shippable set. VERIFIED.
- Tracked-artifact check using Git was not run, because the user forbade Git. The export approximation stands in for it. NOT_TESTED via Git.
- Historical DBs (`.work/ordertruth.sqlite`, `.work/stage1d/review/fault.sqlite`, `.work/runs/gate1-human-demo-prep/actual-evidence-demo.sqlite`) and `.env` were not opened or modified. No PayPal or model calls; ₹0.

## 6. Gaps

- A symlinked alias of a protected path is NOT_TESTED: creating symlinks on Windows needs elevated privileges. Resolved-path and case-changed aliases are VERIFIED.
- The clean export is an approximation without Git. Fresh online install is NOT_TESTED.
- Desktop-emulated screenshots of long pages were unreliable in the preview pane (a capture scaling glitch). The DOM check confirmed no overflow (`scrollWidth 1425 ≤ 1440`), and narrow-pane screenshots were used instead.
- Screen reader, a full WCAG 2.2 audit, real users, authentication/RBAC, hosting, live AI and other platforms: NOT_TESTED.
- Genuine human TTY approval in this run: NOT_TESTED. Recorded once earlier (Stage 1D), RECORDED_NOT_REPRODUCED.

## 7. License options (no LICENSE added; needs the user's decision)

| Option | Effect | Fit |
|---|---|---|
| **MIT** | Short and permissive: anyone may use, modify and redistribute, with attribution. | Simplest for judges and reuse. Gives no patent grant. |
| **Apache-2.0** | Permissive with an explicit patent grant and a NOTICE convention. | Permissive like MIT but with patent clarity; slightly longer. |
| **AGPL-3.0** | Strong copyleft, including for network use. | Stops closed SaaS forks, but deters reuse. |
| **All rights reserved / source-available** (e.g. view-only for judging) | Code is public to read but not licensed for reuse. | Keeps every right; check that the Devpost rules accept it. |

Before choosing, recheck the hackathon rules for any open-source requirement. Claude will add the chosen `LICENSE` only after explicit approval.

## 8. Ranked blockers to submission

1. **License decision.** Needs the user's choice (§7). It blocks a public repository.
2. **Judge access through 15 Dec 2026.** No hosting decision yet. The local setup is documented and verified on Windows only.
3. **Demo video under 3 minutes**, recorded from the working app. Not started.
4. **AI role.** Value against the rules baseline is not measured, and the live evaluation is BLOCKED (`docs/GATE2C_AI_RESULTS.md`). The rules require a meaningful AI role.
5. **Authentication and RBAC are absent.** Disclosed, but judges may weigh it.
6. Accessibility audit and cross-platform setup: NOT_TESTED.

## 9. Commands to validate (for the user or Codex)

```bash
pnpm check
pnpm build
pnpm exec vitest run tests/gate3a-console-correctness.test.ts tests/gate2d-serving.test.ts
pnpm console:demo --out .work/console-demo/gate3a-check.sqlite
pnpm incidents --db .work/console-demo/gate3a-check.sqlite
```

Files to review before any commit: §1. Claude made no Git commands or commits.
