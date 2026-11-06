# Phases 0–5 engineering checkpoint — November 5, 2026

## Source and preservation (G0 VERIFIED)

Working checkout: `C:/projects/ordertruth`, branch `fixes`, HEAD `02e06ec7475bab2f0365144aea65655e31681a61`. Recorded `origin/main`: `eb39f1549b34f67f2acb67a52d87e28be62cfb1b`; recorded `origin/fixes`: `bfc2ab79cbc162a147023dbaa5113c1f3680b252`. These are local refs, not a fresh GitHub/CI observation. `fixes` is 14 commits ahead of recorded upstream. Local `main` is `44baaed`, behind its recorded upstream by 17 commits. No branches, commits, index entries, pushes, merges or deployments were created.

Preexisting README changes and every nonignored untracked file were copied with SHA-256 hashes into `.work/runs/handoff-20261105/preserved/`; `preservation.json` and `preexisting.patch` record that state. Ignored historical evidence and secrets were neither copied nor read. Experimental HEAD differs from recorded public main by 130 files, 16,211 additions and 3 deletions. No existing dirty work was replaced.

Isolation: ordinary source archives under ignored `.work/runs/handoff-20261105/`, rather than Git worktrees, avoid all Git-state writes. `main.tar` is an exact `git archive origin/main` fallback. The release directory is extracted from that archive. It excludes the entire experimental branch and all new work from this session. PostgreSQL tests use only fresh random databases in explicitly named disposable containers; no application `.env` is loaded. Host Node24 is outside project requirements; authoritative runtime qualification uses cached image `ot-v3-w1-validation:00844c0b1ebf`, Node22.18.0. No provider/model calls were made.

## Defects (G1 local evidence)

Existing Lab modules were reused without changing their historical bytes:
- `packages/lab-merchant/src/v-a/original.ts`: separate intent existence check, awaited barrier and insert.
- `packages/lab-merchant/src/nc/nc3-key-on-path.ts`: existence scoped to intent plus handler path.
- `packages/lab-merchant/src/v-a/reference-fix.ts`: transactional guard claim.

`tests/v3-postgres/defect-matrix.integration.ts` freezes eight matrix cases. Sequential / forced overlap results: race writer 1/2, cross-path writer 2/2, corrected writer 1/1, corrected writer with two distinct purchases/captures 2/2. The barrier checks real PostgreSQL advisory-lock waiters, rather than sleeping and assuming overlap. Evidence records handler/capture identity, SQL check rows and attempts for vulnerable writers, barrier arrivals, guard outcomes and final rows. Guard transactional/concurrency/restart/rollback/identity controls remain independently exercised by the existing PostgreSQL suite.

Raw host evidence: `.work/runs/handoff-20261105/matrix/*.json`, `v3-postgres-final.log` (97/97). Additional journal integration: `journal.log` (3/3), `webhook/*.json`. VERIFIED Node22: all 100 PostgreSQL tests passed across 11 files (`current-node22-postgres.log`); the eight matrix cases and three journal tests are included. Node22 raw rows/traces are in `node22-matrix/` and `node22-webhook/`. The 165.52-second run completed normally; no tests were killed. Node22 typecheck passed and 63/63 targeted offline tests passed. These are SYNTHETIC_FIXTURE experiments, never PayPal evidence.

Important failed probe retained: `matrix.log` and `matrix-retry.log` show the guard rejecting a second capture on the SAME intent (`IDENTITY_CONFLICT`). The frozen merchant lifecycle permits one primary obligation per intent; two legitimate independent purchases therefore use separate intents (`SYN-OBS-1` / `SYN-OBS-2`). This does not qualify split fulfillment, multiple captures per purchase or universal one-capture/one-order rules. The existing secondary intent uniqueness was not silently removed. The first full PostgreSQL run failed one child startup test because a passwordless test URL violated its required nonempty environment; correcting only disposable connection setup yielded 97/97. No assertions were weakened.

## Webhook preparation (G2 PENDING AUTHORIZATION)

`src/merchant/lab-webhook-adapter.ts` requires persisted verified intake proof and processed event state, read-only fresh matching capture readback, payee/order/intent/amount/currency agreement and matching capability before invoking the injected actual Lab handler. It fails closed outside Sandbox and exposes no capture/refund method. It is absent from hosted startup. `src/merchant/lab-webhook-journal.ts` provides scoped durable event exclusion, transactional vulnerable-writer queries and replay receipts. The corrected guard remains independently capture-idempotent. Journal and guarded writer use separate transactions; a crash after guarded commit before journal commit relies on corrected-writer reuse, not an unsupported claim of cross-transaction atomicity.

Offline tests: real intake/processor with fake PayPal verification/readback and actual NC3 handler at mocked SQL boundary; separate PostgreSQL journal/writer tests. These do NOT establish a complete live signature-to-database demonstration. A production-authority capability issuance bridge, persisted proof loader and owner-selected listener/tunnel runner still need final composition and review before live execution. No live webhook PASS is claimed.

Reviewable proposed live scope, requiring separate owner authorization after composition: exactly one USD1.00 Sandbox purchase, one create-order POST and at most one capture POST after manual buyer approval; read-only GETs for checkout/webhook/corrected replay; at most five signature verification postbacks. One temporary Sandbox webhook registration and deletion only if explicitly approved, using an owner-approved HTTPS tunnel. Reuse immutable captured evidence for the corrected writer; do not buy a second payment merely to test a fix. Expected real-money cost ₹0; no paid tunnel, model, hosting or live API. Separate fresh experiment databases; no judge writes. Stop on live host/config, amount/identity disagreement, uncertain capture outcome, unexpected mutation, unavailable verification or charge. Sanitize tokens, credentials, signatures and PII before storing evidence; retain hashes/IDs/statuses only as necessary. Do not use `injectDuplicate` as webhook-causation proof.

## AI preparation (G3 NOT TESTED)

New bounded local harness: `src/ai/code-investigation/`, `tests/code-investigation.test.ts`, protocol `docs/CODE_INVESTIGATION_PROTOCOL.md`. Six synthetic variants include split paths, clean code and reserved held-out cases; developer-visible labels are not independent blinding. Frozen scoring/schema/context digest is emitted by the CLI. The static comparator proposes an inert repair, not only a detection label. No arbitrary proposal execution, model call or patch auto-installation exists. Five contract tests pass; static baseline six diagnoses correct, zero false positives, four repair proposals, zero executed patch regressions. Semantic minimality and model usefulness remain NOT_TESTED. Do not include this in the release or claim AI superiority until an approved pilot and independent patch regressions qualify it.

## Merchant UX (G4 NOT TESTED)

`docs/MERCHANT_UX_INTEGRATION.md` supplies source-based endpoint and recovery contracts and isolated frontend ownership for Claude. No frontend files or dependencies changed. Await an actual UX patch, build/contract validation and independent operator review. Tabs are presentation, not server-enforced RBAC. Repairs use stored evidence, not a fresh provider readback at every execution; shipping, inventory and communications are outside scope.

## Local release candidate (G5 AT-RISK; baseline-only qualification)

Release directory: `.work/runs/handoff-20261105/release/`. Source identity is public-main ref above. Candidate delta is EMPTY: preserve V2; exclude Ask/W2/W3, experimental Lab, unqualified AI and absent UX work. Exact baseline and session file hashes are in `source-manifest.json`. This is a fallback release snapshot, not a claim that all requested new capabilities are integrated.

VERIFIED on Node22: frozen dependency install with complete repository config, typecheck, 790/790 offline tests, 43/43 disposable PostgreSQL tests, both hosted Vite builds and frontend packaging. API source is typechecked and exercised by offline/PostgreSQL integration tests; this project has no separate API compile script. Logs: `frozen-install-final.log`, `release-typecheck.log`, `release-tests-final.log`, `release-postgres.log`, `release-build.log`. Dependency audit (`pnpm audit --json`) flags 12 advisories: 1 high (Zod <4.6.6, GHSA-mrhx-c7xc-m3w5), 6 moderate and 5 low. These affect the unchanged baseline; application exploitability was NOT_TESTED. Security qualification is AT-RISK, not clean. Exact findings: `dependency-audit.json`. No dependency edits were made because this candidate has no release delta and the handoff limits fixes to introduced failures. Review baseline exposure and authorize a separate scoped dependency remediation if required. No remote CI was queried or triggered: PUBLIC CI PENDING. No hosted/judge-access qualification, deployment, final recording or submission was attempted.

Failed setup probes are retained: network-disabled frozen install lacked registry policy metadata; incomplete install probe omitted existing `pnpm-workspace.yaml`; corrected complete probe passed without source fixes. Initial container cache permissions and temporary Windows shell line endings also failed before corrected runs. Host Node24 full offline run: 1150 passed/21 failed, child startup errors (`uv_os_get_passwd`) in five files; do not conflate that environment with Node22 qualification. Experimental Node22 full run reproduced the Ask exact evidence-reference mismatch (1168 passed / 3 failed); two additional preexisting tests timed out under full parallel load. Targeted rerun with two workers passed all 63 tests across the two previously timed-out files and both new offline test files. No timeouts or assertions were changed. Ask is absent from the baseline; do not delete its tests from experimental source.

## Risks, cost and next actions

1. Live webhook path remains unqualified: finish composition/review, then obtain owner approval for the exact Sandbox actions above.
2. AI benefit remains unknown: freeze independent review protocol and obtain provider/call-cap/₹0 approval before any pilot; stop expansion if it ties/fails.
3. Baseline-only candidate contains no new UX/demo capability: qualify each proposed delta independently before promotion. Supply Claude with UX contract; owner transfers reports to independent reviewers.

External spend ₹0; model calls 0. No owner commit/publication authorization inferred. No secrets or application credentials read. All preexisting changes remain in place. Next authorized work is independent review of the local evidence and candidate manifest; new UX changes and final live composition require their corresponding artifacts, not fabricated success.

## Review artifacts and scans

`implementation.patch`, `changed-file-allowlist.json` and `local-implementation-review.zip` contain only the 12 new session files. The original ten dirty files remain byte-identical to the preservation manifest. `source-manifest.json` records all 291 baseline files and new-file SHA-256s. A bounded credential-pattern scan found seven baseline files with explicit fake/offline/test fixture literals and no new-file matches; this is not exhaustive certification. No dependencies changed. New APIs are absent from hosted startup, and no frontend files changed.
