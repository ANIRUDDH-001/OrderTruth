# Phase 3 unified integration

7 November 2026 IST. Local source qualification; no hosted release authorization.

## Source and history

VERIFIED by `git fetch origin` and `git ls-remote`: remote handoff `c700db9b22e1db54fb75e917bb561dd50785c7eb`, Phase 1 `35871bad936388ef1d8781178c6963e9feda917d`, main `eb39f1549b34f67f2acb67a52d87e28be62cfb1b` matched the requested identities. The original local main checkout was `e8967ed`; it and its untracked `.serena/` were left untouched.

Worktree: `D:\Projects\OrderTruth-audit-20261107-6db2858d\Unified`. Branch: `integration/ordertruth-unified`. Created at V3, then `git merge --no-commit --no-ff 35871bad936388ef1d8781178c6963e9feda917d`; common ancestor `a9dba8cb9d7909cae6cd2bc1a7bf8f3f46dc3ae4`. Both histories are preserved by a two-parent merge. Final commit and CI identities are recorded in the publication checkpoint below.

## Conflicts and resolutions

No textual conflicts. The only independently overlapping source file was `web/judge/main.ts`: the automatic merge retained the premium Phase 1 workflow and V3's ordinary `/lab/` navigation. Independent review compared every Phase 1 changed file: only the intended Lab link and qualification Git PATH addition differed from that source before the subsequent Lab presentation change.

Semantic boundaries reviewed:

- `vite.judge.config.ts` retains V3's multi-page Lab/plugin; Phase 1 packaging retains the fail-closed preview guard. No production rewrite or deployment setting changed.
- V9 belongs to the V2 merchant schema. V3 tests use their own disposable databases and an independent PostgreSQL cluster/job; no runtime bridge to the merchant recovery store was introduced.
- `src/webhooks/intake.ts` retains the separate legacy adapter contract and PostgreSQL verify-before-persist contract. The new persistence path acknowledges only after durable authenticated proof; duplicate and invalid ingress do not create new durable proof rows.
- Exact plan/hash approval, session ownership, same-origin writes, server expiry and independent receipt verification remain Phase 1 behavior.
- No frozen G3 identities, consumed holdouts, historical publication bytes, guard/verifier implementation or accepted test results were edited.

Integration fixes:

1. `scripts/qualification.ps1`: allow only the first resolved Git executable directory in the safe child PATH. The Lab otherwise displayed an unavailable publishing commit. Diagnostics established `spawnSync git ENOENT`; multiple Git applications had initially combined into one invalid path. Root environment and secrets remain excluded.
2. V3 crash test: Windows reports self-SIGKILL as `(code=1, signal=null)`, independently reproduced. The test now requires the exact platform result plus an explicit flushed crash-hook marker, one committed order, absent terminal journal and restart reuse. No financial or recovery assertion was weakened.
3. Lab artifact links: a browser click originally navigated to JSON despite being described as a download. Explicit filename download attributes were added after a failing regression test. Artifact bytes are unchanged.
4. CI: independent V3 PostgreSQL 18 service/job added, including package typecheck. It does not share V2's server/database.

## Local qualification

VERIFIED on Node **22.18.0**, pnpm **11.4.0**, frozen dependencies. PostgreSQL **18** binary/version, actual data directory, user, port and durability checked before V2 migrations. Isolated child environments excluded owner credentials and provider/model adapters rejected external network.

| Check | Observed result | Ignored local evidence |
|---|---|---|
| Frozen install | PASS | `.work/runs/install.log` |
| Root typecheck | PASS; repeated after fixes | `typecheck.log`, `typecheck-final.log` |
| Package typecheck | PASS | `typecheck-packages.log` |
| Full offline suite | 1,272 passed / 72 files | `offline.log` |
| V2 PostgreSQL including populated V8→V9/replay | 56 passed / 11 files | `v2-postgres.log` |
| V3 PostgreSQL | Initial 112 pass / 1 platform-assertion failure; corrected 113 passed / 13 files | `v3-postgres-before-portability.log`, `v3-postgres.log` |
| Publication, negative controls and target safety | 36 passed / 6 files | `publication-negative.log` |
| Download regression | Observed RED, then 4 Lab UI tests PASS | `lab-download-red.log`, `lab-download-green.log` |
| Actual frontend builds | PASS including built Lab/owner assets | `build-download-fixed.log` |
| Actual Vercel preview packaging | Expected exit 1 before publication | `preview-rejection.json` |
| Publication bytes | All eight files checked; seven manifest pins match | `publication-review.json` |

V2 cluster: worktree-owned `.work/postgres/data`, loopback `55432`, database `ordertruth`. V3: independently initialized `.work/v3-postgres/data`, loopback `55433`, administrative database `postgres`; tests create random `otg_*` databases and remove only those. V3 runner verifies ownership/version and stops its cluster in `finally`. No V3 connection used V2 or Neon. The first V3 launch failed before testing because the private launcher's pnpm PATH was incomplete; corrected without changing dependencies or product code.

Docker was not available on the command path. Full containerized Gate A verifier, image isolation and cleanup reproduction are **NOT_TESTED**. Historical container records are **RECORDED_NOT_REPRODUCED**, separately from current local PG tests. No G3/model evaluation or consumed holdout was rerun.

## Actual built-in browser evidence

Codex in-app browser used the built frontends, real session API and owned PostgreSQL. Screenshots and sanitized route-template request logs remain private under `.work/qualification/unified/` and `.work/qualification/requests.jsonl`; they are not published with the branch.

- VERIFIED: anonymous session → imported historical genuine Sandbox E34 observation (19 October, original time/hash retained) → controlled duplicate → deterministic check → AI unavailable with rules-based fallback → exact plan → separate approval/execution → independent receipt → reload/reopen. No fresh provider request was made or implied.
- VERIFIED: truncated postcommit creation response reconciled the saved UUID by GET; no replacement POST. `creation-recovered.png`.
- VERIFIED: truncated postcommit execution response preserved uncertainty, explicit recheck found the committed receipt. `execution-interrupted.png`.
- VERIFIED: invalid independent receipt response withdrew current-verification claims and retained historical receipt only. `receipt-read-failure.png`.
- VERIFIED: actual hashed expired plan, generated through the real service under a test-only past clock, displayed renewal; new exact approval and execution succeeded by keyboard. No immutable plan field was edited. `expired-plan.png`, `renewed-keyboard-receipt.png`.
- VERIFIED: stopping backend and PG produced a connection-unconfirmed state, disabled new-case mutation and offered read-only retry. Both restarted; same browser session reopened the verified receipt. `receipt-after-full-restart.png`.
- VERIFIED: desktop and 390px receipt; 320/390px Lab had no document-wide horizontal overflow in measured browser viewports. Lab navigation and public manifest JSON route opened; publishing identity displayed the actual precommit SHA and dirty state after the PATH fix. `receipt-desktop.png`, `receipt-mobile390.png`, `lab-mobile390.png`, `lab-width320.png`.
- LIMITATION: the browser download API timed out after clicking the corrected explicit download link, while the page remained on Lab. Saved-file completion is **NOT_TESTED**. Original JSON navigation was reproduced; download attributes are covered by regression, public bytes/hash verification is independent. Do not substitute this for a saved-file browser pass.
- Full screen-reader/WCAG certification and production cold-start timing are **NOT_TESTED**.

The historical observation import used read-only legacy SQLite and preserved original HTTP/evidence metadata with a transparent local-import annotation. It is private local qualification data, never staged or relabelled fresh. Synthetic fixtures remain distinct from that observation, merchant writes and advisory hypotheses.

## Publication and release decision

VERIFIED: staged source inventory and credential-pattern screening; no `.work`, `.env`, local database or private holdout staged. Eight public Lab artifacts checked against hashes and common credential/private-key/token/credential-URL patterns; no matches. Manual provenance review finds explicitly synthetic IDs and historical limitations, not fresh PayPal or AI-superiority proof. Hash consistency is not independent attestation.

The supplied Vercel log is an **expected safety rejection** on Phase 1: builds succeeded and preview packaging refused a production-coupled API rewrite. Node settings warning did not cause failure. Unified packaging reproduces that refusal. This branch is deliberately not a usable interactive hosted preview; bypassing the guard would reintroduce the unsafe production coupling.

Independent read-only merge review: no important defects found; migration, payment/auth boundaries, frozen identities and dedicated-branch push safety retained. Reviewer did not independently rerun the reported suites.

Hosted readiness remains **HOLD**: no deployment/promotion API was invoked, and no Neon inspection/migration, hosted source/schema cutover, quota validation or judge-access qualification occurred. Existing Git integration automatically attempted Vercel preview builds after push; packaging refused them. V9 needs a separately approved maintenance/drain/backup/rollback plan. A V8 backend cannot simply be pointed at an already migrated V9 database.

Recommendation: unified is suitable as a reviewed development candidate with a read-only historical appendix, but **Phase 1 remains the lower-scope submission/release fallback** until hosted rehearsal qualifies the selected exact source. Do not postpone a viable Phase 1 hosted release for Docker, V3 runtime experiments or cosmetic Lab work. No claim of production readiness, fresh PayPal verification, natural webhook causality or AI superiority.

Cost: initiated service spend ₹0; product PayPal/model calls 0; no billable resource or billing changes. Assistant inference billing is unmetered here.

Next safe actions: owner chooses Phase 1 or unified for separately authorized hosted qualification. Confirm the exact Neon target read-only, then approve a bounded V9 cutover and hosted merchant rehearsal separately. A usable interactive preview needs its own isolated API/database; do not bypass the existing refusal. Preserve all original branches and evidence. Docker reproduction and saved-file download verification may continue independently and must not delay a viable merchant release.

## Lab case-study refinement

Final qualified code SHA: **`ccd043171d590d9545989d34dc05ebc92fbae641`**. The subsequent report-only commit changes no implementation, tests, evidence or deployment configuration. Its exact publication SHA is supplied in the delivery message; a report cannot contain its own object hash.

Only `web/judge/lab/view.ts`, `web/judge/lab/style.css` and `tests/lab-ui.test.ts` changed in this follow-up. The existing merchant journey was not edited. No new demo/runtime mode, dependency, font or external asset was added.

VERIFIED: the default Lab view explains the business problem, recorded two-order/one-order comparison, shared guarded operation and evidence boundaries. A closed native **Technical Verification** disclosure contains every rung code, control matrix, JSON download, source identity and SHA-256. Supporting checks now use populated tables with check names, outcomes and evidence source; limitations and explanatory steps use explicitly styled text lists, with no empty items.

Tests: the new disclosure/content regression failed before implementation, then **32 focused tests in four files passed**, root typecheck passed and frontend build passed. Existing publication negative controls still check fabricated/rehashed artifacts independently. This presentation-only change did not invalidate V2/V3 behavior tests; CI still runs both suites on the exact code SHA.

Actual Codex built-in browser: desktop **1440px**, mobile **390px** and narrow **320px**. Default view hides technical hashes; keyboard Enter opens/closes the disclosure; nested check tables show meaningful populated rows. At 320px, document scroll width was305px, viewport320px, zero empty list items and all eight explicit artifact download links were present. Tables may scroll within their own container. Return navigation by keyboard reopened the existing genuine-observation merchant receipt; console warnings/errors were empty. Temporary viewport overrides were reset.

Clean committed build displayed publishing SHA `ccd043171d590d9545989d34dc05ebc92fbae641` and **Clean publication build**, separately from historical source S. Screenshots: `.work/qualification/unified/case-study-final-desktop.png`, `case-study-mobile390.png`, `case-study-mobile320.png`, `case-study-technical-mobile.png`, `case-study-technical320.png`, `merchant-return-final.png`; machine-readable summary `browser-final.json`. These local paths are not portable public artifacts.

VERIFIED: `/`, `/lab/`, `/lab/index.html`, `/owner/` and all six referenced packaged assets passed direct routing checks. All **eight** served `/lab/evidence/*` responses were HTTP200 and byte-identical to committed source files (`.work/runs/publication-http.json`). The seven historical manifest artifact hashes and all frozen identities remain unchanged. Saved-file completion through Codex's download API remains the explicit limitation above.

Public artifact review: all eight JSON artifacts were inspected for credential/private-key/token/credential-URL patterns and independently reviewed for PII, private endpoints and misleading claims. No sensitive findings. URL-shaped content in historical test logs refers to public Vitest documentation. Original results were not deleted or rewritten. Historical synthetic execution remains recorded rather than independently attested; build verification establishes consistency, not fresh execution or PayPal contact.

Independent review of the final presentation and public artifacts found no important defects. The reviewer did not independently exercise browser behavior. No additional product/release defect was discovered by the cosmetic pass.

## Publication checkpoint

- Merge SHA: `4d35e1f66c8e7973ffb4203a3d7218f8cea11b43`; parents exactly V3 `c700db9b22e1db54fb75e917bb561dd50785c7eb` and Phase1 `35871bad936388ef1d8781178c6963e9feda917d`.
- Merge CI: [42366069953](https://github.com/ANIRUDDH-001/OrderTruth/actions/runs/42366069953), **PASS** for offline/build (1,272 tests), V2 PG (56), V3 PG (113).
- Final code SHA: `ccd043171d590d9545989d34dc05ebc92fbae641`, pushed to the dedicated branch. CI [42366481147](https://github.com/ANIRUDDH-001/OrderTruth/actions/runs/42366481147): **PASS**, all three jobs: offline/build (1,273 tests), V2 PostgreSQL (56), V3 PostgreSQL (113).
- Vercel automatic preview `dpl_7oKqGm4yvm79WzeJhKhYJ1Ku99xw`: **expected ERROR/refused**. Read-only build-log inspection reproduced the exact `Preview API isolation is not qualified` packaging error on the final code push. This is separate from GitHub Actions success. No deployable write-capable preview was produced.
- Remote main, Phase1 and handoff refs rechecked after publication: unchanged at the supplied SHAs. Original local checkouts and owner data preserved.

UNIFIED SOURCE INTEGRATION: PASS (local scope and stated browser/Docker limitations)

HOSTED RELEASE READINESS: HOLD
