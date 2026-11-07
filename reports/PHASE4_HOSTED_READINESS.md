# Phase 4 hosted readiness

7 November 2026 IST. **STATUS: Phase 4; HOLD for hosted release.** Local qualification is separate from hosted authorization. No hosted configuration, deployment, production SQL/export, payment call or model inference was performed.

## Source and verified state

Approved starting source: `f3d873f32e130ca041a5653e79e96fb9832e5458`, `integration/ordertruth-unified`. Working directory: `D:\Projects\OrderTruth-audit-20261107-6db2858d\Unified`. Owner's stale main checkout and untracked files preserved. Final publication identities and CI are appended after publication; a report cannot contain its own commit hash.

| Boundary | VERIFIED observation | Limits |
|---|---|---|
| Git | Remote main `eb39f1549b34f67f2acb67a52d87e28be62cfb1b`; fallback `35871bad936388ef1d8781178c6963e9feda917d`; unified matched approved start | Recheck before cutover |
| Vercel production | `dpl_Gcj74J2XKQufcTb5dCB4eSPgHLcv`, SHA `eb39f1549b34f67f2acb67a52d87e28be62cfb1b`, READY, main, Git source | READY is deployment state, not product qualification |
| Production aliases | `order-truth.vercel.app`, `order-truth-algominds-projects-68a5e35a.vercel.app`, `order-truth-git-main-algominds-projects-68a5e35a.vercel.app` | API rewrite targets shared Render backend |
| Vercel project | `prj_nrggq1Ff6H4quFytF33PH5b4MNs5`, team `team_dKCxOthHp76gtaT5JaK6BIFE`, Vite, Node setting24.x; source engines22 | Connector project response omits raw build/install settings; source build is `pnpm build:frontend`, output `dist/judge` |
| Historical READY preview | `dpl_CzE6oHFtYmJ4cUZDEKG4BTwED6fn`, handoff `c700db9b22e1db54fb75e917bb561dd50785c7eb` | Its pinned `vercel.json` rewrites API to production Render. Neon preview branches do not isolate this rewrite. Live authenticated preview request NOT_TESTED; no protection/share link was created |
| Preview policy | Unified Git deployment disabled in source; manual preview packaging refuses shared API | Does not retire historical READY previews; backend barrier must cover them |
| Render | `srv-dbccdgjl550s73d37ao0`, workspace `tea-d6qpqrpaae7s739l8qu0`, live `dep-dbcfi0eea8bs73fd2030`, SHA `e8967edc59b94f4a28b58d09661408cef7131bed` | Different frontend/backend SHAs are current historical state |
| Render configuration | main, autoDeploy=no/trigger off, free, one instance, Virginia, previews off; healthCheckPath empty; platform maintenance disabled | Public direct Render hostname remains enabled |
| Render commands | build `corepack enable && pnpm install --frozen-lockfile && pnpm build:hosted`; start `pnpm hosted:start` | No hosted change made |
| Neon identity | project `sparkling-bonus-45187791`, primary `br-dry-wildflower-b7tskz9y` / main, database `neondb`, owner `neondb_owner`, PG18 | Owner confirmed intended target in this chat. Connection/SQL identity is NOT_TESTED; no credential fetched |
| Neon recovery metadata | organization `org-holy-lake-50023579`, plan free, Vercel-managed; history retention21600s | Actual usable restore point and production restore permissions NOT_TESTED |
| Production schema | Both public `/api/health` responses report schema8 | Application-reported, not direct SQL verification |
| Starting CI | GitHub run42367278170: offline, postgres, v3-postgres jobs independently read back successful | Historical test counts not substituted for current tests |

## Reliability

VERIFIED: bounded read-only health samples in this session: direct Render HTTP200/563ms, production rewrite HTTP200/1021ms, both sandbox/schema8. Earlier Phase3 timeout15s and rewritten13.4s remain RECORDED_NOT_REPRODUCED. These warm samples do not refute earlier delays.

VERIFIED: Render app logs show multiple distinct instance startup messages on November6–7, including November7 11:11:10 UTC. No startup failure appeared in the bounded filtered sample. Source initializes/migrates the database before listening; pool connection timeout10s, statement timeout15s, lock timeout5s. Existing health reports process existence, not database readiness. `trustProxy:false` means no untrusted forwarded-IP assumption; shared reverse-proxy IP rate limiting remains a hosted qualification concern.

HYPOTHESIS: free-tier wake-up contributes materially to long responses. [Render documents](https://render.com/docs/free) idle spin-down after15min and approximately1min wake-up. No controlled idle/wake experiment or request-to-startup correlation was performed. New startup timing logs distinguish database initialization from later serving; they are not deployed yet. Frontend GET budget90s, write45s; GET-only retries and visible waiting notice remain. Writes are never automatically repeated. No keep-alive traffic/automation created.

## Implemented release safeguards

- `src/server/maintenance-app.ts`: bridge performs only managed-version SELECT8/9, registers no auth/business/provider handlers and does not migrate. All API traffic except process health/status receives retryable503, including direct Render webhooks. No authentic evidence is falsely acknowledged or dropped after acknowledgement.
- `src/server/release-barrier.ts`: gate before auth/body parsing; covers GET session refreshes that can write. Tracks admitted requests conservatively. Closed state plus zero requests means **this process** is quiescent only. Lost-response uncertainty remains nonzero; another process, pending capture claim or webhook backlog requires independent reconciliation. No public barrier mutation endpoint.
- Persistent hosted modes: `maintenance`=bridge; `hold`=V9 app with closed gate; `normal`=compatible runtime. Invalid mode fails startup. Hosted ephemeral barrier files are rejected; local file state supports browser entry/exit testing.
- `src/server/hosted-main.ts`: hosted startup checks V9 by default; only explicit `ORDERTRUTH_MIGRATION=apply-v9` applies migrations. Render source SHA required. Startup timing emits only allowlisted operational metadata.
- Judge builds carry source SHA; scenario writes require matching `x-ordertruth-source`. Stale V8 empty-body creation cannot mutate V9. Header is compatibility metadata, **not authorization**; session ownership, same-origin, exact approval and server checks remain mandatory. Owner financial endpoints retain their own authentication/reauthentication; maintenance blocks them all.
- Case DTO adds only historical capture status/currency/value from selected immutable genuine HTTP200 readback. Single completed capture/order identity checked; malformed/synthetic/ambiguous input yields null. No merchant-total inference, raw payload or provider identity added.
- V3 test scheduling now counts only the current database's exact advisory-lock waiters. Deterministic negative regression observed RED with unrelated database waiter, then GREEN after correction. Frozen merchant/evaluation/publication bytes unchanged.

## Compatibility and recovery

| Runtime | Schema8 | Schema9 |
|---|---|---|
| Historical V8 application | Historical supported pair | **FORBIDDEN**; cannot roll back here |
| New maintenance bridge | Read-only version check; API closed | Read-only version check; API closed |
| New V9 with migration disabled | Refuses before listen | Starts; hold remains closed |
| New V9 explicit migration, hold | Transactional additive8→9 | Idempotent replay, closed |
| V8 browser / old preview against V9 | N/A | Scenario writes409; reload; existing compatible reads allowed only after gate opens |

VERIFIED local populated V8 rehearsal: synthetic auth user/session, scenario, accepted synthetic readback, merchant orders, completed repair receipt and pending webhook delivery. All preexisting table rows compared before/after migration. Concurrent/repeated migration succeeds; malformed legacy timestamp rolls back V9 DDL/journal atomically. Bridge preserves8, incompatible V9 startup refuses, migration commits9 under closed gate, compatible restart/readiness succeeds. No V8 application was started over9. Exact historical V8 HTTP operation is RECORDED_NOT_REPRODUCED; setup uses V8 schema and real compatible domain services, not a recompiled historical server.

VERIFIED local backup: PG18 custom archive, archive list validation, restore into newly created owned disposable database with `--single-transaction --exit-on-error --no-owner --no-privileges`; every table row, sequence and constraint compared. Populated V8:38tables/76rows; existing local V9:40tables/190rows at its earlier recovery point. Truncated archive rejected. Private archives stay ignored. Local restore uses same DB role; hosted role grants/Neon integration routing and full backup of auth/public schemas still need target-specific verification. No production export made.

[Neon Free documentation](https://neon.com/docs/introduction/plans) gives6h history, subject to its history allowance. Metadata agrees21600s; this is not a verified production backup. Required primary recovery: authorized direct-connection full-database export at closed/drained boundary, restored and compared in approved local private storage before migration. PITR is an additional option only after usable point/permissions/zero-cost route confirmed. Preserve auth/session/token rows privately, provider evidence, scenario operation identities, approval hashes, receipts, webhook deliveries/events/audit, sequences, constraints, roles/grants and source/schema identity. No V9 down-migration. After9 commitment use compatible bridge/hold and forward fix. A pre-V9 restore discards all post-backup writes; never do it automatically or silently replay payments. Target RPO0 only while the barrier and all-process drain are proven; otherwise STOP.

## Qualification and remaining release gates

VERIFIED current local campaign: offline1,282/75files, root typecheck, frontend build; V2PostgreSQL57/11files including local populatedV8 backup; independent V3PostgreSQL114/14files. Verifier manifest5/5 confirms frozen trusted files unchanged after moving the new scheduling helper outside the frozen harness. Initial V3 race failure and the deterministic negative regression are retained privately; no assertion weakened. Exact CI links and committed source identity are appended in the publication checkpoint. Browser evidence lives in `reports/PHASE4_BROWSER_QUALIFICATION.md`; executable sequence and stop conditions in `reports/PHASE4_V9_CUTOVER_RUNBOOK.md`.

P0 release blockers: production SQL schema/connection identity, stopped legacy processes and uncertain capture reconciliation, verified authorized backup/recovery point. P1: actual hosted readiness/rewrites/cold start, proxy rate-limit behavior, staged frontend identity and hosted browser qualification. No remaining confirmed P0/P1 **local code** defect after narrow independent review; that does not clear hosted blockers.

Sandbox qualification after separate permission: owner manually approves a Sandbox buyer order, server captures once with stable request ID, GET readback verifies capture/status/amount/currency, store evidence, inspect via judge case; genuine signature/HTTPS webhook qualification is separate. This release request includes **zero PayPal and zero external model calls**; fresh Sandbox evidence is not claimed.

## Sensitive authorization scope

Request one bounded cutover for the owner-confirmed Neon project/branch/database and final CI-green source: read-only SQL identity/preflight; private full database export to ignored local storage and local restore/verification; Render persistent mode/health configuration and exact-commit bridge→hold/migration→normal deployments; Vercel exact-source staged production build and eventual production promotion. Never merge main. Maximum hosted product mutations: one anonymous judge session, one UUID case, one controlled duplicate, one deterministic check, one exact plan, one approval, one merchant-only execution; read-only receipt/reopen checks. Authentication rate-limit/session bookkeeping and migration journal/admission backfill are additional expected persisted writes. Diagnostics/model execution/payment/webhook administration excluded. Cost cap₹0: stop if any stage requires billing/quota purchase or new paid resource.

HOLD until this scope is explicitly authorized and all fail-closed cutover gates pass. No sensitive action is implied by successful local tests.
