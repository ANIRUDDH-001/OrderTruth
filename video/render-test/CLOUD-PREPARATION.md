# OrderTruth cloud adapters — prepared, not published

The local preparation is complete. Live capture, session recovery, plan creation, approval, execution, receipt reload, rendering and visual QC are **NOT_TESTED**. No final film is claimed. No guest credential was read during preparation.

## Verified workspace and scope

Workspace: `C:\projects\ordertruth-video`. Isolated checkout: `cloud-stage1-checkout`, branch `video/cloud-render`, HEAD `534ff613a9c588cbeb62985bf0c0290d1e9cd1d3`. Read-only remote verification in this preparation matched that SHA and main `f667b0b0273c5ea2f465df543af283aa12c0c7d2`. Git initially rejected ownership; per-command `-c safe.directory=C:/projects/ordertruth-video/cloud-stage1-checkout` enabled inspection without changing Git configuration. Sandbox network access failed; the approved read-only `ls-remote` succeeded. Git also warned it could not read the owner's global ignore file; repository status and scoped checks still completed. Workspace and checkout write probes passed.

Only `.github/workflows/video-render.yml` and files beneath `video/render-test/` are in the publication scope. Original application, application tests, vercel.json, lockfile, tool installer, Phase A, original footage and approved graphics remain unchanged. The Temp derivative script and audit named in the request were present. No Stage 1 work was repeated. Scratch workers were integrated sequentially; their generation scripts and temporary test outputs are excluded.

`PUBLICATION-SCOPE.sha256` is the exact proposed file allowlist with hashes (excluding its own hash). `production/assembly-assets.json` inventories 13 copied assets: the existing deterministic MP4, 11 existing scene WAVs and sanitized narration QC. These are copies, not regenerated media. `production/scene-sources.review.json` additionally pins the three existing approved graphics. Review these media before authorizing their later inclusion in the public repository. Do not add the entire footage or Temp directories.

## Implemented contracts

Capture: `production/resume-existing-case.cjs`, `capture-policy.cjs` and its synthetic tests. It requires locked `playwright`, pinned browser version under `PLAYWRIGHT_BROWSERS_PATH`, independent FFMPEG_PATH/FFPROBE_PATH, and an Actions runner. Recording is 1920x1080 at DPR1. Plan, approve and execute each permit one exact POST and never replay it, even after an uncertain response. API reads are restricted to the same case/session/history and exact receipt. New guests, cases, duplicates, AI, provider writes and changed repair scopes are blocked. Current case/orders and plan/hash/expiry are checked before writes. Approval and execution are different pushes. Execution records real receipt verification and the same receipt after page reload. MP4 verification includes full decode; intervals are corrected to the encoded recording clock, rejecting discrepancies of two seconds or more.

Session state exists only in a runner-private temporary directory. The secret is removed from the process environment before Chromium starts. Source errors and server responses are never logged or serialized wholesale. Public metadata is a primitive-field projection. Cleanup runs in script `finally`, signal handlers and workflow `always()`; the ephemeral hosted runner is the final disposal boundary if the process or machine is killed. No raw recording, storage state, screenshot, arbitrary failure report or wildcard directory is uploaded.

Assembly: the original sequential assembler now accepts `--manifest`, with `--validate-only` performing no render or probe. It pins sources/proof/audio hashes, validates case/orders/receipt identity, exact 11-scene boundaries and caption timing, and calculates moving-footage and held-frame coverage separately. Evidence events must match a hash-bound capture sidecar and be inside selected cuts. Final mode requires genuine successful AI evidence plus executed repair and the same reopened receipt; changing a mode flag cannot satisfy it. The supplied review manifest stays visibly labelled INCOMPLETE REVIEW throughout. Narration is accurately attributed to FFmpeg 9.0.2 bundled offline libflite, voice slt. Existing WAVs and approved graphics are reused. Hosted encoding remains sequential H264/AAC 1080p30, with full decode, 4,860-frame and under-180-second checks.

The supplied review manifest validates to 162 seconds: 111.063 moving product-picture seconds, 98.096 unique source seconds, 26.937 held-frame seconds and 24 graphic seconds. Reused intervals are not counted as independent evidence. The S10 review shot holds the previous proposal and explicitly says the outcome is pending.

## Local checks actually run

From `cloud-stage1-checkout/video/render-test`:

```powershell
node --check production/resume-existing-case.cjs
node production/resume-existing-case.cjs --policy-self-test
python production/test_assembly_manifest.py
python production/assemble-host.py final/cloud --manifest production/scene-sources.review.json --validate-only
node scripts/verify-assets.mjs
node scripts/verify-publication.cjs
node scripts/test-cloud-stage-guard.cjs
python scripts/test-workflow.py
git -c safe.directory=C:/projects/ordertruth-video/cloud-stage1-checkout diff --check
```

Observed: capture 8/8 tests PASS; assembly 28/28 PASS; real review manifest PASS with `finalDemoComplete:false`; original asset verification PASS; 12 stage-guard cases PASS; workflow structural checks PASS; syntax checks PASS; final whitespace check PASS. The initial whitespace check found CRLF in new source; source line endings were fixed without changing approved media. Python source was additionally parsed with `ast.parse`; no Python render was invoked. `test-workflow.py` uses locally available PyYAML; it is a local review check, not a new runner dependency. No browser, heavy encoding, AI request or hosted mutation ran.

## Owner-only secure provisioning — later, not performed

1. In repository Settings → Environments, create/review `ordertruth-video`. Restrict deployment branches to `video/cloud-render`, require an appropriate owner reviewer and prevent self-approval where available. This is an Actions environment gate, not an application deployment. An administrator must provision it before authorizing capture. Do not rely on the workflow merely naming an environment as proof that protection rules exist.
2. Authenticate GitHub CLI as the repository owner with secret administration permission. Run the following privately in a normal owner terminal, without transcription/debug tracing. It reads the original session locally, retains its cookies, drops nonessential localStorage, and streams base64 through stdin to an environment secret. It does not print or save the secret and does not create a guest. Do not paste its value into chat or a workflow input.

```powershell
$ErrorActionPreference = 'Stop'
$SessionPath = 'C:\projects\ordertruth-video\footage\deterministic-host-20261111\private\guest-session.json'
try {
  $StoredSession = Get-Content -Raw -LiteralPath $SessionPath | ConvertFrom-Json
  $StateJson = @{ cookies = @($StoredSession.cookies); origins = @() } | ConvertTo-Json -Depth 20 -Compress
  $SessionB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($StateJson))
  if ([Text.Encoding]::UTF8.GetByteCount($SessionB64) -gt 48000) { throw 'Session exceeds secret budget; stop without uploading' }
  $SessionB64 | gh secret set ORDERTRUTH_GUEST_SESSION_B64 --repo ANIRUDDH-001/OrderTruth --env ordertruth-video
  if ($LASTEXITCODE -ne 0) { throw 'Secret provisioning failed' }
} finally {
  Remove-Variable StoredSession,StateJson,SessionB64 -ErrorAction SilentlyContinue
}
```

3. Verify only the secret NAME with `gh secret list --repo ANIRUDDH-001/OrderTruth --env ordertruth-video`. Do not inspect its value. Preserve the original session file. The adapter rejects foreign/nonsecure/non-HttpOnly cookies and any localStorage. An expired session is a blocker; it must never be replaced automatically. Remove the environment secret after the authorized continuation work is finished. No provider key is needed or allowed in this workflow.

## Exact next publication and hosted sequence — later authorization required

The implemented trigger is **push to the existing video/cloud-render branch**. There is no dispatch button requirement and no main-branch merge. Every push must contain exactly one reviewed commit, include `[skip render]` in its commit message, have only video-scoped changes, and set `production/cloud-stage.json.expectedBefore` to the exact current remote video SHA. The guard checks event.before = HEAD parent = expectedBefore and run_attempt = 1. It does not increment a run_number gate. A normal single-commit push is required; do not force-push, batch multiple commits or rerun a previous job.

First publication is the current `stage:validate`, `authorization:NONE`, empty plan fields and review-manifest path. After explicit publication authorization, recheck the remote refs; if the video SHA changed, stop and reconcile rather than overwriting it. Review the allowlisted files, stage exactly those files plus PUBLICATION-SCOPE.sha256, inspect the staged diff, create one commit with `[skip render]`, then push `HEAD:refs/heads/video/cloud-render`. That push runs browser-free validation only; it neither installs browsers nor receives the session secret. Approve the environment review only for the reviewed commit. Keep the current Stage 1 run untouched.

For each subsequent stage, update only the reviewed stage configuration (and explicitly reviewed evidence/manifest assets when assembling), set expectedBefore to the newly verified remote video HEAD, refresh the inventory hashes for changed files and add any newly reviewed asset paths, then repeat the single-commit reviewed push and environment approval. `node scripts/verify-publication.cjs` must pass before publication:

| Stage | authorization | Plan fields | Effect |
|---|---|---|---|
| plan | PREPARE_FRESH_PLAN | both empty | Restore original session/case and prepare one fresh proposal; no approval/execution |
| approve | APPROVE_EXACT_PLAN | actual fresh id + sha256 | Approve precisely that unexpired proposal once; no execution |
| execute | EXECUTE_EXACT_PLAN | same actual reviewed id + sha256 | Execute the already approved proposal once and verify/reopen persisted receipt |
| assemble-review | ASSEMBLE_REVIEW | both empty | Render the explicitly incomplete review manifest |
| assemble-final | ASSEMBLE_FINAL | both empty | Render `production/scene-sources.final.json` only after all evidence/narration gates pass |

After plan, download `ordertruth-plan-<run_id>` and review `fresh-plan.json` plus footage: case `run_0ddc4e8b-f040-4ad7-8ea2-098f8beeae95`, keeper `mo_bf9bb97b-495c-473f-9905-1627b85dec99`, sole void `mo_fbf7e14b-8ebf-4b49-8385-0857ff21f04e`, actual plan ID/hash and expiresAt. Owner approval must name those exact values. The old expired plan conveys no authority. Check expiry before BOTH approve and execute; the adapter requires more than ten seconds remaining when admitting either write. Runner startup/install and environment review consume that window. If expiry occurs, stop; separately authorize a new plan stage and review the new ID/hash from scratch. Approval cannot transfer between plans.

After approve, inspect its sanitized artifact before separately authorizing execute. If any stage fails or times out after a possible POST, do not retry or publish another mutation stage until the owner reconciles the same persisted case using the original session. The workflow intentionally has no automatic mutation retry or recovery write.

After successful execute, review `ordertruth-execute-<run_id>` and its matching receipt ID, one active keeper, unchanged provider evidence and reopened receipt. Import only reviewed `continuation.mp4` and sanitized `capture.json` into a new `production-assets/continuation/<stage>/` directory. Add each as a separately hashed source/proof in the manifest; preserve source order and exact source intervals. Do not overwrite the deterministic take. Keep review mode until the genuine AI footage and appropriate approved final narration exist. For final assembly, create the separately reviewed final manifest and set the config manifest path to `production/scene-sources.final.json`; that file is deliberately absent today. Artifact names and exact allowed files are in the workflow. Final visual review remains required after hosted technical QC.

## Remaining blockers and concrete next action

No valid recorded AI investigation was found in the available nonsecret evidence: deterministic capture has empty aiResponses and cap zero; the prior audit agrees. AI allowance remains ZERO. The owner must verify free provider quota and explicitly authorize a bounded Autopilot run with a numeric provider-request cap before any future AI adapter change or call. Existing adapters intentionally cannot make that call. Invalid historical evaluation outputs are not acceptable evidence.

Live continuation still needs the owner-provisioned original session, protected environment, fresh exact-plan review and separate approve/execute authorizations. Final assembly additionally needs genuine AI footage and final narration matching it. These do not block this completed preparation.

**Next action:** review this concrete diff and PUBLICATION-SCOPE.sha256, then authorize the single `validate` branch push. No publication, workflow execution, secret administration or live case access has been performed here.
