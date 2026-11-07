# OrderTruth production release and delivery

7 November2026 IST. Final deployment checkpoint below records the completed operator run. Evidence classifications: VERIFIED means independently observed here; NOT_TESTED remains explicit. No claim of financial production certification, complete accessibility conformance or long-term uptime.

## Milestones

| Milestone | Current evidence |
|---|---|
|A — public application online | PASS: final main/frontend/NORMAL backend331d5e3622fa07c8a4472caaae9366435afec17c match; V9/readiness200; actual17publicassets hashed and compiled SHA verified. |
|B — hosted product verified | PASS: one fresh guest, one UUID case, one controlled duplicate, deterministic check, disabled-AI fallback, exact plan, keyboard approval and one execution; SUCCEEDED receipt independently verified and reopened after reload and Lab navigation; desktop/mobile passed. |
|C — repeatable delivery | PASS for authenticated operator-assisted delivery: implemented, reviewed and actual complete operator run passed. Main protected by three CI checks, admins included, strict/up-to-date, linear history, no force-push/deletion. GitHub public verifier requires no credentials. Fully unattended hosted orchestration is not configured; see operator steps. |
|D — handoff | PASS: this document, actual screenshots/sanitized logs, immutable release record, CI and deployment IDs below. |

## User-visible product and hosted qualification

Public origin: https://order-truth.vercel.app. API: https://ordertruth.onrender.com. The unified merchant experience and optional Integration Lab are deployed from main. The Lab retains its historical synthetic experiment labels and Technical Verification disclosure; it does not imply a fresh PayPal interaction or installed production guard.

Built-in browser qualification on c1756c2:

1. Existing historical guest receipt first reopened successfully. Added a real Sign out UI control over the existing same-origin API, independently confirmed signed-out state; no cookie manipulation or bypass.
2. Created exactly one new anonymous guest and one case `run_4658fb57-363a-4db1-bb3e-bbbcb917638d` using the genuine stored21October Sandbox observation E5, recorded completed captureUSD1.00. No new PayPal call.
3. Introduced one controlled merchant-only duplicate, detected it once, and invoked the explicitly disabled AI path once. It honestly returned rules-based unavailable guidance; no external inference or diagnostic mutation.
4. Generated exact plan `rp_67544d0c-8cbf-4f2c-ad11-2d591c7d9123`, SHA256 `9c9e8807755936eb2c16a830898729636227674fc5a2f0cbecd52df61dc6f189`; one keeper, one local void, no provider effect. Keyboard approved once and executed once as separate actions.
5. Persisted receipt SUCCEEDED at21:58:29IST. UI independently re-read one active matching keeper and unchanged stored provider evidence. Reload reopened the same case/receipt. Mobile390×844 showed no horizontal overflow; Lab navigation returned to the same verified receipt. Console warnings/errors0 in the bounded sample; no visible action error.
6. Independent read-only SQL confirmed2 total orders,1active,1voided; exactly1SUCCEEDED outcome; stored provider-before/after hashes equal; exactly1PLANNED/APPROVED/SUCCEEDED audit event. Repeated later during release preparation with same result. No duplicate write was repeated after an uncertain response.

Screenshots (private, ignored): `.work/phase5/browser/guest-start-desktop.png`, `findings-desktop.png`, `approved-plan-desktop.png`, `receipt-desktop.png`, `receipt-reloaded-desktop.png`, `receipt-mobile.png`, `lab-mobile.png`; `result.json` records exact action ceiling. These are actual production browser screenshots, not local fixtures.

Sanitized90-response Render sample: all200, one each guest creation/case/duplicate/check/investigate/plan/approve/execute; four independent receipt GETs. Maximum sampled server processing215ms. Readiness samples571msdirect/408msrewrite; these are warm samples, no cold-start causal claim. Unauthenticated case read with a forged forwarded-IP header returned401. Multi-client proxy/IP fairness was NOT_TESTED; trustProxy remains false. Logs exclude raw URLs, headers, bodies, cookies and payment payloads; request IDs/templates/timing only. Evidence `.work/phase5/http-sanitized.json`, `http-summary.json`, `public-probes.json`.

## Data preservation and recovery

Neon project sparkling-bonus-45187791, branch br-dry-wildflower-b7tskz9y, database neondb. Schema journal1..9 verified, pending/uncertain captures0, webhook obligations0, prepared transactions0. No migration, destructive restore, downgrade, existing-record deletion or new backup was run during this milestone. Phase4B's independently restored encrypted post-drain archive remains retained privately; no substitute snapshot invented.

Baseline before the hosted journey hashed3existing payment attempts,30evidence rows and6existing receipts; all39original row IDs/content hashes remained identical after the journey. New case/merchant/audit rows are the authorized additions. The new receipt's independent SQL result is in `.work/phase5/receipt-sql.json`; baseline/preservation results in the same restricted ignored directory. The release operator additionally compares19 recovery/payment/scenario tables across the closed deployment window. Auth session/rate-limit bookkeeping is expected separately.

Provider calls initiated0; fresh captures/refunds0; webhook subscription changes0; external model calls0. NORMAL start explicitly fixes AI_PROVIDER=disabled and daily limits0. Incremental monetary spending initiated₹0; existing free/Hobby resources only. Build/compute/egress allowance consumed; exact final provider billing usage unavailable. No payment method was requested or added. Assistant inference cost not metered.

## Permanent identity and verification

`scripts/frontend-source.ts` now ignores an exactly empty provider SHA, validates every nonempty identity, rejects conflicting values and rejects checkout mismatch. Missing hosted identity fails closed. A source-header compatibility check remains separate from authorization.

`scripts/package-frontend.mjs` emits public `/release.json` after judge/owner build and copy. It records full SHA, UTC build time, target, phase1-core-v1 contract, generated judge entry and every generated serving asset's byte count/SHA256. Generation inspects the actual minified judge bundle's embedded SHA; no secrets/environment dump or public private diagnostics. Lab's historical hashes are not mistaken for current app identity. Manifest served no-store.

`scripts/public-release.ts` publicly downloads every listed artifact, validates hashes, requires judge/Lab/owner pages, confirms verified index loads verified judge JS and independently inspects its embedded source. It refuses foreign URLs/traversal/API paths, incomplete inventories, stale SHA, tampering, oversized artifacts and redirects. On c1756c2 all17actual public serving artifacts passed, without authentication, bypass tokens or privileged URLs.

Regression evidence: empty/missing/invalid/stale/conflicting source; actual minifier backticks; generated-byte hash tampering; incomplete/unsafe inventory; latest queued/failed CI attempt; non-V9/pending capture/webhook/transaction gate. Initial RED failures observed before correction. Frozen Lab publication and trusted package inputs preserved; a convenience package.json alias was removed after CI correctly refused its drift. No frozen test or manifest was weakened.

CI links: c1756c2 https://github.com/ANIRUDDH-001/OrderTruth/actions/runs/42390820164; delivery candidate331d5e3622fa07c8a4472caaae9366435afec17c https://github.com/ANIRUDDH-001/OrderTruth/actions/runs/42393154060. Each has offline/typecheck/frontend build and independent V2/V3 PostgreSQL checks. No live provider/model calls in CI. Reviewed source fixes were committed/pushed under explicit master authorization; main advanced only by ordinary ancestry-checked fast-forward after green checks.

## Next release — executable operator procedure

Use main as production source and the integration branch for reviewed development. Do not push directly to main outside this coordinated path. Vercel Git production follows main; unsafe production-coupled previews fail packaging. Render autodeploy deliberately remains off so it cannot open incompatible code independently.

After reviewing the change and successful latest offline/postgres/v3-postgres checks:

```powershell
node --import tsx scripts/release.ts FULL_QUALIFIED_SHA --database-env D:/Projects/OrderTruth/.env --plan
node --import tsx scripts/release.ts FULL_QUALIFIED_SHA --database-env D:/Projects/OrderTruth/.env
```

The private env path is local and never uploaded; never put its credential values in command arguments or chat. The command uses existing authenticated gh/Render CLI configuration, exact service/workspace/origin checks and explicit free-plan/one-instance/autodeploy-off verification. No new credentials or deployment-protection bypass.

Actual sequence: validate latest CI and ancestry/clean tracked tree → deploy proven compatible source in persistent HOLD → conservative60s routing+maximum300s shutdown retirement floor, old instance absence and CLOSED → private read-only V9/pending/uncertain-merchant gate and19table fingerprints → ordinary fast-forward main → Vercel Git public manifest/assets verified → exact target Render HOLD → fingerprint preservation → latest main/CI rechecked → exact target NORMAL → direct and rewritten source/contract/readiness+static bytes rechecked → immutable ignored timestamped provenance record. No database migration opt-in; database-code changes refuse and require a separately reviewed procedure. A20minute budget applies before failure recovery.

On failure the operator redeploys the last proven V9-compatible source under HOLD and verifies retirement/CLOSED. A settings update alone is never presented as a closed running service. Never run V8 over V9, automatically restore old data, or replay payments/repair execution. A real main-CI timing failure exercised the operator failure path: it refused NORMAL, redeployed compatible HOLD and independently verified CLOSED/retirement before exiting. Destructive/provider faults were not injected. Safety policy also has deterministic gate tests. Successful actual operator run evidence follows below.

`.github/workflows/production-verification.yml` follows successful main CI, pins the exact workflow SHA, downloads public assets and verifies both backend ingress identities/readiness. It has read-only repository permission and no provider credentials. It uploads immutable sanitized verification artifact for30days and fails if deployment READY never becomes application-ready. It does not deploy or pretend it can close production without authentication.

**Remaining zero-touch setup:** repository Actions secret inventory is empty. Existing local CLI logins are not GitHub-runner credentials. The safe process is an authenticated operator command plus automated independent verification. Fully unattended orchestration needs an explicitly approved runner credential/federation route with the existing service scopes and private SQL access (or a supported self-hosted authenticated runner). No new secrets, runner or paid resources were silently created. This is the exact remaining setup step, not an invented automatic pipeline.

## Final checkpoint

**PASS — public app ONLINE/NORMAL.** Exact main/frontend/backend SHA `331d5e3622fa07c8a4472caaae9366435afec17c`.

- Vercel production `dpl_ARwdr85mgGGnMoruyAjAhsFSAjhj`, Git main, READY, normal production aliases; public release manifest SHA256 `fa6d00438e3ccee5c10717d55bbba340164bdb3a254737bccb0deabd1a91fb6f`,17assets verified, judge-0OG5FKrT.js independently embeds331d5e3.
- Render final NORMAL `dep-dbnlqre417fc73e44sbg`, exact331; final target HOLD predecessor `dep-dbnlq2rm8hqs73civjj0`. Migration opt-in absent, autodeployoff, AI disabled. Direct and rewritten source/schema9/contract/readiness verified.
- Actual release command PASS17:20:06UTC, immutable record `.work/releases/331d5e3622fa07c8a4472caaae9366435afec17c-2026-11-07T17-20-06-358Z.json`.19recovery-table fingerprints preserved across closure. No migration/provider/model calls.
- Main CI https://github.com/ANIRUDDH-001/OrderTruth/actions/runs/42394004754 PASS attempt2. Attempt1 failed a frozen pool-exhaustion wallclock assertion4018ms versus3000; exactsameSHAdev had passed. One bounded failed-job rerun passed. Scheduling delay remains HYPOTHESIS, no assertion/guard weakened. Operator correctly refused NORMAL and actually verified compatible HOLD recovery before clean retry.
- Public verification https://github.com/ANIRUDDH-001/OrderTruth/actions/runs/42394441443 PASS attempt2, immutable verification artifact uploaded. First verification timed out during extended HOLD/recovery; rerun after actual readiness passed, not fabricated success.
- Independent SQL17:20:35UTC confirms same receipt,2orders/1active/1voided, one outcome and each expected audit event. Original39payment/evidence/receipt rows unchanged. Actual built-in browser reopened same persisted receipt after final deployment; screenshot `.work/phase5/browser/final-331-receipt.png`. No repeated case or repair write.
- The browser setting/tool mismatch was retried after owner restored access; final browser check succeeded. No login/bypass credential created during this milestone. Public maintenance error is cleared in NORMAL; planned-maintenance messaging needs a clearer user-facing presentation and is queued with the subsequent enhancement.

PWA/icons/logo are the next owner-requested task. Logo proposal must be approved before it is assigned. Fully unattended hosting orchestration still requires the explicit runner authentication setup described above; current tested delivery is operator-assisted, not zero-touch.



## Approved PWA and brand follow-up

Owner approved **Option1 — Verified O** after comparing three generated proposals. Production assets use a clean SVG interpretation of that approved mark, with committed raster derivatives: ICO16/32/48; SVG favicon; PNG16–1024; Apple120/152/167/180; separate opaque maskable192/512; Windows tile/browserconfig and Safari pinned-tab icon. `scripts/generate-icons.mjs` reproducibly renders them using locally installed resvg2.6.2; no frozen package input changed.

The web manifest uses standalone display, stable root identity, overview start URL, workspace/Lab shortcuts, theme/background colors and regular/maskable icons. Optional install UI invokes the browser's real install prompt; it does not fabricate installation or prompt availability. Safari/iOS uses its normal Share→Add to Home Screen flow; native OS installation on every platform is not claimed tested.

Service worker caches **only a neutral offline explanation**. API/session/evidence/case/receipt/release responses are never cached. No POST interception, background sync, approval/payment/repair queue or replay. Failed navigation shows a reconnect page without payment facts or verified-state assertions. Core application remains online-required.

Planned maintenance now has a dedicated friendly paused-service presentation and GET-only availability check. Only exact503+RELEASE_MAINTENANCE is classified that way; real network/server/authorization failures and uncertain writes retain their warnings. Root-cause regression and reconnect tests pass. Actual local browser served the corrected maintenance page; stopping the owned test server then reloading proved service-worker offline fallback. Evidence `.work/pwa/maintenance-local.png`, `offline-local.png`. These are explicitly local static-harness tests, not synthetic hosted payment evidence. Existing actual hosted recovery remains the one authorized case above.

PWA publication checkpoint will be recorded after its exact-SHA CI/release completes.
