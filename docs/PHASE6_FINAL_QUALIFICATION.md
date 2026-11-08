# Phase 6 final local qualification

**PASS: defined local checks. HOLD: live AI, hosted release, full competition qualification.**

Authoritative runtime Node 22.18.0, pnpm 11.4.0, local PostgreSQL 18. Host default 24.22.1 was not used for final campaigns. Managed loopback DB only; random V2 schemas and V3 databases. No root application credentials, hosted Neon records, PayPal requests or live inference used.

| Check | Observed result | Ignored evidence `.work/runs/phase6/` |
|---|---|---|
| Frozen install | PASS | frozen-install-qualified.log |
| Main/package typechecks | PASS | typecheck-qualified.log, packages-qualified.log |
| Offline vitest, maxWorkers2 | 82 files, 1,306 passed, 0 failed/skipped | offline-qualified.log |
| V2 PG, maxWorkers2 | 11 files, 64 passed | v2-qualified.log |
| V3 PG, maxWorkers2 | 14 files, 114 passed | v3-qualified.log |
| Frontend build | PASS | build-final.log |
| Dependency audit | 2 moderate, 0 high/critical | audit-final.json |
| Actual browser recovery/reload | PASS; synthetic evidence, real HTTP/PG | browser-server.log; Codex observations |
| Separate SQL | active 1, voided 1, original capture intact, one SUCCEEDED, equal stored hashes | browser-sql-proof.json |
| Hosted read-only metadata | matching base SHA / schema 9 / ready true | connector and HTTP responses |

Earlier failures retained: payment-path red reproductions; 17 evaluator compatibility failures before separating the new transport; manifest drift before historical preservation/current regeneration. Assertions, fixture labels and old reports were not softened or relabelled.

Initial remote CI on `57065d7` passed both PostgreSQL jobs but failed the exact preview-configuration assertion: the Phase 6 deployment block was added after the local campaign. The strict expected map was extended to both authorized blocked branches, with an explicit check that main is unaffected. No assertion was removed or loosened; this is a configuration expectation change. `.work/runs/phase6/ci-failure.log` retains the failed run. Final exact-commit CI must pass before claiming remote qualification.

## Browser reproduction and cleanup

With managed DB running and `pnpm build:frontend` complete, set NODE_ENV=test and run `pnpm exec tsx tests/helpers/phase6-browser-server.ts`. Open `http://127.0.0.1:3016/qualification/`. Helper binds loopback, refuses nonowned DB URLs, loads no root.env, forbids outbound fetch, creates a random schema and bounds runtime 20 minutes. Its qualification creation route is absent from hosted startup. This does not test the production genuine-source admission path.

Signal cleanup is best effort on Windows; Ctrl+C alone is not proof of deletion. After stopping, the integrator independently checked no listener on 3016, identified exactly one owned schema by the unique synthetic browser-order marker, reverified postconditions, and removed that schema. Managed PostgreSQL remains available; no hosted cleanup occurred.

NOT TESTED: fresh genuine payment/refund; HTTPS webhook signature→merchant effects; private model holdouts; live schema/latency/tokens/value; hosted proxy fairness; full screen-reader audit; container topology; backup/restore; sustained access; final video/submission. Model list is supplied; live inference remains blocked by authorization and unresolved privacy/output gates. No preview/production deployment or hosted data mutation occurred.
