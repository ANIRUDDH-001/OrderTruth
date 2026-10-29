# Release preflight checkpoint — 26 October 2026

STATUS: Gate 3; AT-RISK. Local provisional candidate checks pass; hosted release qualification remains incomplete.

## Candidate and evidence

VERIFIED: base commit `09fbde56864b91ef9dce67a72bea5f9cd2fbaf5f`, with uncommitted changes. The existing isolated export contains 278 file entries and has manifest identity `6efb02d307ad20a0d12100c5d04f5cc8c2b51208477cfaf47d0f9defeab08d89`. Every non-deleted manifest entry matched both the working source and candidate before execution. This is a provisional source snapshot, not a clean committed release or proof of deployed versions.

Local evidence is retained in `.work/runs/release-preflight-2026-10-26/` and `.work/runs/release-followup-2026-10-26/`; those folders are ignored and are not required to run the product. This report records their observed outcomes without publishing private configuration. The teammate handoff and this report were added after candidate capture; neither changes runtime code. Future application edits require affected checks to be repeated.

## Local checks

| Check | Classification and outcome | Evidence / command |
| --- | --- | --- |
| Supported runtime | VERIFIED Node 22.18.0 | `.work/tools/node-v22.18.0-win-x64/node.exe --version` |
| Candidate dependency installation | RECORDED_NOT_REPRODUCED: inspected earlier same-day result and install log, exit 0, pnpm 11.4.0 | `install --frozen-lockfile --store-dir .work/tools/pnpm-store`; prior `install-result.json` and `install.log` |
| Candidate typecheck | RECORDED_NOT_REPRODUCED: inspected earlier same-day result, exit 0 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`; prior `typecheck-result.json` |
| Offline suite | VERIFIED 701 passed, 33 files, 0 failed/skipped, 58.52 seconds | Node 22: `node_modules/vitest/vitest.mjs run --maxWorkers=2`; followup `offline.log` |
| Checkout, console, judge and owner builds | VERIFIED all four exit 0 | Node 22 runs Vite with default, console, judge and owner configs; individual followup logs and result JSON |
| Frontend packaging | VERIFIED exit 0 | Node 22 `scripts/package-frontend.mjs` |
| PostgreSQL suite | VERIFIED 43 passed, 9 files, 0 failed/skipped, 29.03 seconds | Managed candidate loopback cluster only; `vitest run --config vitest.postgres.config.ts --maxWorkers=2`; followup `postgres.log` |
| Database cleanup | VERIFIED managed local cluster stopped, committed local data retained | Existing `pg-cycle.cjs` finally block; followup `postgres.log` |
| Whitespace check | VERIFIED `git diff --check`, exit 0 | CRLF conversion warnings are retained; no whitespace errors |

The first same-day candidate test attempt failed on unavailable temporary files; its 30 failed files are retained, not relabelled as passes. An earlier restricted PostgreSQL attempt also failed. The followup used normal local temporary-file/process access, without changing tests, assertions or product code. Installation reused a pnpm store; an empty-cache download/install remains NOT_TESTED. PostgreSQL credentials stayed inside the ignored managed cluster, and no hosted database was used.

## Public deployment observations

VERIFIED: three bounded, unauthenticated GET requests through `https://order-truth.vercel.app` completed on 26 October 2026. Followup `public-check.json` records status and elapsed time; no response cookies or credentials were saved.

| Route | Observed result |
| --- | --- |
| `/` | HTTP 200; OrderTruth HTML; 792 ms |
| `/api/health` | HTTP 200; `ok:true`, `environment:sandbox`, `persistence:postgresql`, `schemaVersion:8`; 73,229 ms |
| `/api/paypal/browser-config` | HTTP 403 without authentication; 1,148 ms |

The 73-second health response is an access risk. Prior host idle duration is unknown; this is not a measured cold-start qualification. The proposed 90-second recovery target has not been accepted or proven through the frontend. Health does not establish the exact deployed commit, actual secret configuration, payment correctness, database permissions or the full session authorization matrix.

VERIFIED browser observation: the public page showed a skip link, labelled operations/engineering controls, original Sandbox observation, controlled merchant-state labels, and a previously existing case/exact repair plan. Browser storage/session state was reused. No repair approval, execution, model invocation or payment action was performed. This is not independent-session, keyboard-complete, mobile, screen-reader or WCAG qualification.

## Free-access research and outstanding account checks

Official pages were consulted on 26 October 2026. Published rules do not establish this team's remaining account allowances.

- [Render Free documentation](https://render.com/docs/free): idle services sleep after 15 minutes; 750 instance hours are shared per workspace/month. Free service shell access is unavailable. Exact hosted process fault injection therefore needs a supported, approved mechanism; routine redeployment is not equivalent evidence.
- [Vercel Hobby documentation](https://vercel.com/docs/plans/hobby): use and quota restrictions apply. Inspect this project's actual plan/usage and applicable use conditions before claiming judging-period coverage.
- [Neon plans](https://neon.com/docs/introduction/plans): verify the actual project plan, compute/storage/transfer usage, retention and recovery options. No hosted schema was inspected or deleted in this checkpoint.
- [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits): limits depend on model/project and are visible in AI Studio. The application's own daily limits do not prove provider capacity. No inference was made to test quota.

No paid fallback, keep-alive monitor, billing change or scheduled automation was created. Continuous availability through 15 December remains an ongoing requirement, not a guarantee.

## Next checks and boundaries

1. Bind frontend and backend deployment identities to the candidate; inspect account allowances read-only without exposing secrets.
2. Run an isolated fresh judge session through the actual frontend, then session/expiry/ownership and bounded failure drills. Preserve receipts; test unavailable/quota paths through controlled fixtures.
3. Complete manual accessibility and real desktop/mobile journeys; give the teammate the written judge instructions for a documented unassisted rehearsal once ready.
4. Prepare a concrete genuine webhook procedure using existing Sandbox evidence where possible. New payment/account changes need their specific approval. Hosted crash qualification needs a safe mechanism; do not add a public fault endpoint.
5. Inspect Neon schema ownership/dependencies read-only before proposing any exact cleanup. No destructive action is approved.

Top risks: slow judge entry; deployed-source/account-allowance uncertainty; unqualified accessibility and hosted fault boundaries. Local passing tests do not resolve these risks.

COST / QUOTA: no new PayPal or Gemini calls, billing changes or paid resources. Assistant inference accounting unavailable. IMPLEMENTED: teammate instructions and this checkpoint; no product edits. GIT: all existing changes preserved, no staging/commit/push/deployment. AI study unchanged.
