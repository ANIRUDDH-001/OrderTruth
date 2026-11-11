# OrderTruth video — hosted Stage 1

This adapts the reviewed packet and the working host Playwright recorder. It preserves
the approved 11-scene, 162-second film, all three finished graphics, the existing
sequential editor and protected-action safeguards. Original local assets remain intact.

The first authorized push to `video/cloud-render` automatically starts **Video render
test** on standard `windows-2025`. This workflow accepts only its first run/attempt,
the exact public repository `ANIRUDDH-001/OrderTruth`, and a commit containing
`[skip render]`. No dispatch, retry, paid runner, provider credential, deploy command,
Git write from the job, or application secret is used. Timeout: 20 minutes; capture
and encode step: eight minutes. Workflow permissions: `contents: read`; checkout
does not persist credentials. Actions are pinned to commit SHAs.

## Stage 1 execution

1. Install the existing npm lock with lifecycle scripts disabled. Node 24.11.0;
   Playwright 1.66.0-alpha-2026-11-09 fixes Chromium 158.0.8127.18/revision 1254.
   The exact version already used by the local working setup is retained.
2. Download FFmpeg 9.0.2 into runner temporary storage. Verify its archive SHA-256
   against `tool-pins.json` before extracting. Pin source:
   https://github.com/microsoft/winget-pkgs/blob/master/manifests/g/Gyan/FFmpeg/9.0.2/Gyan.FFmpeg.installer.yaml
3. Check original asset hashes and both route-policy self-tests without networking.
4. Create a fresh isolated browser context. Load only the public hosted landing page.
   Allow same-origin GET/HEAD public resources plus GET `/api/session` to verify it
   is signed out. Block other API paths, other origins, writes and WebSockets. No
   clicks, saved user profile, cookie export, traces, sign-in, case or AI request.
   Require real expected page content and confirmed signed-out session; fail if any
   write was attempted. A cold backend may take up to 120 seconds; no POST is retried.
5. Hold the settled page for eight seconds, take a 1920×1080 screenshot, flush WebM
   and close Chromium. Encode a seven-second landing MP4, then a five-second smoke
   MP4 sequentially with FFmpeg. Only actual recorded frames are used; the last
   frame may be held to round the encoder clock. HyperFrames does not block this run.
6. Require H.264/yuv420p, 1920×1080, 30 fps, exactly 210/150 frames, expected duration
   and successful full decode. Reject artifacts over 25 MiB. Any error fails the job.

Artifact `ordertruth-stage1-RUN_ID` contains only `landing.webm`, `landing.mp4`,
`smoke-5s.mp4`, `landing.png` and fixed-schema `qc-public.json`. Retention: 14 days.
Download it before expiry to preserve it for later editing. Browser cache, temporary
raw recording, npm files, headers, response bodies, session/cookie files and logs
are never uploaded. A failed capture uploads only a sanitized failure phase report,
if available, and never partial footage. The page title and signed-out state must
validate before any screenshot is taken. No private case evidence is included.

## Reuse for the actual film

`production/` contains portable copies of the existing capture/editor/PowerShell
runner. Paths are rooted at the scripts; tools come from PATH or `FFMPEG_PATH` /
`FFPROBE_PATH`; fonts come from `WINDIR`. `renders/` contains the three byte-identical
finished graphics. `phase-a/preproduction/timeline.json` is the unchanged approved
162-second narration/shot timeline. The original HyperFrames source and font licenses
remain in this packet, unused by Stage 1. Offline Windows System.Speech narration
and sequential single-thread FFmpeg editing remain in the existing runner.

Stages 2 and 3 are **disabled in CI**, including direct invocation of the protected
capture driver. A job cannot pause for owner input. Stage 2 needs specific approval
for one controlled guest case/duplicate and a confirmed free model-request budget.
Stage 3 needs separate approval of the actual displayed Keep/Void identities and
current plan digest/expiry. Existing interactive prompts and route checks remain.
The noninteractive stage contracts and confidential session continuity must be reviewed
before enabling either stage; do not upload a session/cookie artifact publicly.
The editor still refuses incomplete or unverified receipt captures. No placeholder
evidence or fabricated results can complete the film. A failed stage is never replayed
automatically, and completed Stage 1 footage must be retained/downloaded before expiry.

## Deployment boundary and existing CI

The branch-only root `vercel.json` adds exactly
`git.deploymentEnabled["video/cloud-render"] = false`. Other root settings and
production main are unchanged. Vercel documents this exclusion; it depends on each
connected project reading that effective root configuration, with no matching true
rule or overriding programmatic configuration. Actual connected project roots,
additional projects and external hooks are not verified. No provider-wide isolation
claim is made. https://vercel.com/docs/project-configuration/git-configuration

The sole authorized commit must include `[skip render]`, Render's documented normal
auto-deploy skip. Do not use `[skip ci]`, open a PR, invoke a deploy hook or merge.
Render dashboard branch settings/custom hooks remain unverified; this marker does
not establish their absence. https://render.com/docs/deploys#skipping-an-auto-deploy

Existing unfiltered CI also starts on this push: `offline`, `postgres`, `v3-postgres`.
Its existing disposable test services are unchanged. Production verification's
workflow_run remains filtered to `main` and does not run for this branch.
No application source, root dependency, existing workflow or protected evidence file
is changed. Only this video directory, the new workflow and exact Vercel exclusion
are in publication scope. Main/branch baseline must be rechecked before Git writes.
