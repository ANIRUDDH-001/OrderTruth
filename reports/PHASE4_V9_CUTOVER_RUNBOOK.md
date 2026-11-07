# V8 → V9 cutover runbook

**NOT EXECUTED HOSTED.** Source-pinned local rehearsal only. `CANDIDATE_SHA=58c9869a9e166deed531563cd3056ba53705fef7`; require its CI-green result in readiness publication checkpoint before use. Refuse symbolic branch tips or any different source. A subsequent report-only commit is documentation, not a replacement application deployment target. No authorization is granted by this file.

## Fixed targets and stop conditions

- GitHub `ANIRUDDH-001/OrderTruth`, dedicated `integration/ordertruth-unified`; main/fallback/handoff must remain unchanged.
- Render `srv-dbccdgjl550s73d37ao0`, workspace `tea-d6qpqrpaae7s739l8qu0`, existing free plan, autodeploy OFF.
- Vercel project `prj_nrggq1Ff6H4quFytF33PH5b4MNs5`, team `team_dKCxOthHp76gtaT5JaK6BIFE`; primary alias `order-truth.vercel.app`.
- Neon `sparkling-bonus-45187791`, primary `br-dry-wildflower-b7tskz9y` (main), `neondb`. Owner confirmed identity; actual connection identity still must match. Never use preview branches, inferred DSNs or credential values from tool output.

STOP on source/schema mismatch, active legacy process, pending/uncertain financial operation, unverified backup, restore failure, nonzero incremental cost, auth/session inconsistency, invalid evidence, missing judge access or any unapproved action. Keep API closed on failure. Do not substitute a READY deployment for qualification.

## 1. Preflight, before any mutation

1. Obtain explicit approval for the exact sensitive scope in readiness report. Record approval and UTC time privately without credentials.
2. Recheck remote three refs, clean worktree and candidate CI jobs. `git rev-parse HEAD`, `git status --short`, `git ls-remote origin refs/heads/main refs/heads/integration/ordertruth-unified refs/heads/integration/ordertruth-phase1`. Preserve exact SHA and deployment IDs.
3. Through approved private connection handling, verify hostname/project/branch/database/role against connector metadata. Read-only transaction: `SELECT current_database(),current_user,current_setting('server_version_num');` and `SELECT version,applied_at FROM ordertruth.ordertruth_postgres_migrations ORDER BY version;`. Require managed contiguous1..8. Read catalog/object ownership and confirm full export scope includes auth and all app dependencies; never print connection strings/tokens.
4. Inventory in-flight/pending capture attempts and webhook events via counts/statuses only. Inspect malformed scenario timestamps, migration privileges, constraints and storage headroom. Check pending operation identities before retry. A timeout is not failure. No PayPal reconciliation call is included in approval: stop if provider reconciliation is needed.
5. Verify Neon usable6h recovery point and restore permission/zero-cost entitlement, plus free Render/Vercel allowance. Unknown billing route means no paid fallback. Capture last known frontend/backend IDs/schema8.

## 2. Close the API using the V8-safe bridge

1. After approval, set Render persistent `ORDERTRUTH_RELEASE_MODE=maintenance`; leave `ORDERTRUTH_MIGRATION` unset. Set health path `/api/health` (process health, intentionally200 during maintenance). Keep autodeploy OFF, same free service/build/start command.
2. Trigger exact `commitId=CANDIDATE_SHA` deploy; never deploy latest main. Monitor exact deployment and source readback until live; verify process health reports maintenance and startupSchema version8. Read `/api/release/status`: maintenance=true, activeRequests=0, quiescent=true.
3. Verify direct Render and production Vercel rewrite refuse POST/session traffic503 with retry-after. Webhook routes must return retryable503, never2xx without durable authentic acceptance. Do not fabricate webhook administration/events. Provider retries are finite: time-box closed window20min; if overrun, stop/reconcile delivery history under separate authorization.
4. **Critical old-process gate:** this bridge's zero counter proves only its own state. Confirm previous Render deployment/process has exited, including graceful-shutdown window, and that no other worker/service has this DB write authority. Repeat read-only DB activity/pending-claim/backlog checks. If old activity or uncertain capture exists, do not migrate. Render may SIGKILL after shutdown delay; never infer rollback from that.
5. Historical READY previews and old browser tabs still share the Render URL; the bridge closes their API too. Static maintenance pages alone are insufficient.

## 3. Backup and verification at the drained V8 recovery point

Only after closed API/all-process drain, record time/schema/source and take approved private direct-connection full database custom dump. Secrets via protected environment/passfile, never command arguments/logs/chat. Do not use a pooler for export/administrative session work. Include schemas/auth dependencies; record roles/grants separately without credential material.

Equivalent PG18 operations (connection supplied privately; names are placeholders, not shell interpolation instructions):

```text
pg_dump --format=custom --file <ignored-private-archive> <approved-database-name>
pg_restore --list <ignored-private-archive>
pg_restore --single-transaction --exit-on-error --no-owner --no-privileges --dbname <owned-local-restore-db> <ignored-private-archive>
```

Require archive SHA256, complete table content/sequence/constraint comparison and counts of evidence, operations, sessions, receipts, webhook inbox/audit. Test session/receipt reopening against restored compatible runtime without network adapters; never display tokens/PII. Local no-owner restore does not prove Neon role/grant recovery. Do not proceed with export creation alone. If full private restore scope cannot be safely approved/verified, HOLD. Never create a paid Neon restore branch.

## 4. Commit V9 with the API still closed

1. Same Render source `CANDIDATE_SHA`; persistent `ORDERTRUTH_RELEASE_MODE=hold`, `ORDERTRUTH_MIGRATION=apply-v9`; exact-commit deploy. V8 bridge has no business handlers and no migration path, so no V8 application runs over9.
2. Migration acquires existing schema advisory transaction lock; adds scenario_operations ownership/immutability, scenario_admissions immutable expiry/index/backfill and journal9 atomically. Existing evidence/auth/scenario/receipt/webhook rows unchanged. Observe startup timing, allowlisted failures and deployment source. `/api/health`200/schema9, `/api/release/status` closed/zero; ordinary `/api/readiness` intentionally503 while held.
3. Approved read-only SQL verifies contiguous1..9 and additive objects, all preexisting-row fingerprints, constraints and pending state against backup. Failed transaction must remain8 with no partial V9 objects. Failure after9 commitment means **compatible roll-forward only**.
4. Remove migration opt-in while retaining hold; exact same SHA restart must check9 and remain closed. Do not remove hold on mismatch.

## 5. Stage exact frontend and qualify before public promotion

Prepare a clean checkout of `CANDIDATE_SHA` with zero .env/.work/private files. Bind only the known Vercel project/team IDs locally. Use documented staged production workflow `vercel deploy --prod --skip-domain --build-env ORDERTRUTH_BUILD_SHA=<CANDIDATE_SHA>` (replace placeholder with exact public SHA, no paid build flags); this builds production assets without moving aliases. Explicit source input is required when uploaded source has no .git; Git builds may supply VERCEL_GIT_COMMIT_SHA. Do not bypass manual-preview guard or set VERCEL_ENV=preview with a shared backend. A staged production deployment is production-coupled and is **not isolated staging**; API remains held. Record deployment ID, Git metadata, built merchant source SHA, Lab publishing source and all aliases. Any source mismatch STOP.

The connector's current create_deployment schema does not expose skip-domain assignment; use supported CLI after approval rather than assuming API behavior. Exact CLI version/target metadata must be qualified before use; this hosted command is NOT_TESTED. No project settings changed merely to suppress an engine warning.

Read-only held checks must pass before the bounded authorized write window. Promote the exact staged Vercel deployment **while Render remains held**, then verify aliases/source at the configured production origin. This avoids weakening same-origin authentication for the staged hostname. Set Render `ORDERTRUTH_RELEASE_MODE=normal`, migration opt-in absent; same exact SHA, autodeploy off. Old browsers/previews cannot perform scenario mutations because source header differs/missing; compatible reads do not imply new approval. This opens the matching V9 API for the explicitly approved bounded test, **not final release approval**. Any failure immediately return to hold using same V9-compatible SHA.

Use the production origin, one judge session/case and prescribed mutation ceiling. The staged hostname is not an approved auth-origin workaround. Do not weaken same-origin/security or claim staged-origin auth works. Promotion while held and the subsequent bounded production-origin test must both be included in owner authorization.

Full browser gates: understandable first visit; stored genuine Sandbox provenance and capture facts; UUID case creation; controlled duplicate/deterministic detection; AI unavailable fallback; exact plan; keyboard approval; separate execute; independent persisted receipt; refresh/reopen; mobile/desktop; no unexpected console errors. No PayPal/model/diagnostic calls included. Verify source identity and production readiness9/contract before approving success. Re-hold immediately on defect; roll forward. Keep final public-release hold until this qualification passes.

## 6. Final alias promotion, verification and recovery

Only after successful bounded qualification declare the gate open for release. Recheck the already-promoted aliases, source SHA, direct/rewritten readiness and source identity. Confirm preview suppression and no unintended source/schema changes. Observe a bounded natural idle/wake check without artificial traffic/keep-alive. Record measured timings and request IDs, not an assumed cold-start cause. Preserve judge usability through December15 as an ongoing operational requirement, not a claim proven by one test.

Failure before migration: bridge/hold remains; V8 may return only after independently verifying schema8, old source and no uncertain operations. Failed transaction: verify8/no partial9 before considering V8. Failure after9: never run V8 or down-migrate; compatible bridge or V9 hold, repair forward, repeat qualification. A restore to pre9 is a separate destructive, data-loss decision requiring another approval and reconciliation of every post-backup event. Do not automatically replay capture/repair/webhook calls.

## Local evidence commands

```powershell
./scripts/qualification.ps1 pnpm typecheck
./scripts/qualification.ps1 pnpm test
./scripts/qualification.ps1 pnpm test:postgres
./scripts/qualification.ps1 backup-local
./scripts/qualification.ps1 build
./scripts/qualification.ps1 serve
./scripts/qualification.ps1 stop
./scripts/qualification.ps1 stop-db
```

V2 local suite additionally restores populated V8 when run through this Windows qualification wrapper. CI exercises migration/domain safety, not PG CLI backup or hosted deployment. V3 job independently provisions its own PG18 service; local results and exact CI links are in readiness report. Private evidence paths are ignored and not portable public artifacts.
