# Build the publication and reproduce the fixed lab

These are two different operations. Building the static publication checks committed records; it does not rerun Gate A. Reproducing Gate A executes disposable synthetic merchant/database tests. Neither path calls PayPal or a model.

Public availability of the exact source commit is **NOT_VERIFIED**. Instructions assume a local checkout already containing it. The owner must verify unauthenticated access to both source S and publication P before claiming external reproducibility; see [release gates](V3_RELEASE_GATES.md).

## Read-only Integration Lab publication

Use Node 22.18.0 and pinned pnpm 11.4.0. The committed publication first appears at W1 commit `8300b3ff305d9a71a4dd562b97b0eef6b01708e2`; its Gate A source S predates it. Use a clean, owner-prepared checkout containing W1 for a publishing build. A dirty local build is an honestly labelled preview.

On Windows, choose a short checkout path: deep directories can exceed Git's path-length limit.

```powershell
pnpm install --frozen-lockfile
pnpm build:frontend
```

The second command builds judge and owner pages and packages the owner assets into `dist/judge/owner`. The lab is `dist/judge/lab/index.html`; eight checked JSON downloads are under `dist/judge/lab/evidence/`. Serve `dist/judge` as a static directory with directory-index support; open `/lab/` directly. This static lab needs no backend, private evidence or credentials. The judge/owner routes in the same output still require the separate interactive backend; serving static files alone does not make that workflow functional.

Publication validation happens at build time. [The evidence README](evidence/lab/README.md) explains the seven artifacts plus manifest, historical hash pins, recomputed qualification, source comparison and disclosure limits. A changed manifest cannot authorize a different historical experiment. Bad inputs must stop the build; do not hand-edit them to clear a failure.

For supported-runtime validation of the unchanged W1 build, the existing entry is `node --import tsx scripts/validate-w1.ts`. It creates an allowlisted current-source image, verifies its digest and runs checks before cleanup. It writes into the historical W1 checkpoint directory; preserve earlier logs before a separately approved rerun. Its source inventory excludes this root README and the new W4 narrative documents; it validates W1 code/build inputs, not the prose or current hosted availability. No validation image should be described as having compiled new documents that it never included.

## Historical Gate A execution

Prerequisites: Docker Desktop's healthy Linux engine, pnpm 11.4.0 and an owner-prepared clean disposable checkout at source S. The accepted historical host controller ran Node 24.11.0; the candidate ran supported Node 22.18.0 in containers. A Node 22 host controller for this full historical workflow is NOT_TESTED. Docker storage and memory changes are operator decisions; preserve existing data. W2's smaller reviewed profile belongs to W2 and does not rewrite this historical Gate A profile.

The following commands are instructions for the owner, not authorization for an agent Git action. Selecting S in a separate clean checkout avoids disturbing the current branch or losing uncommitted work:

```powershell
git checkout fc85ac3db1388bd84a3a55b8198d9dc3b2ad6c86
git status --short
pnpm install --frozen-lockfile
git status --short
New-Item -ItemType Directory -Force .work/v3/reproduction | Out-Null
pnpm v3:verify:gate-a *> .work/v3/reproduction/verify.log; $verifyExit = $LASTEXITCODE; "verifier exit $verifyExit" | Set-Content .work/v3/reproduction/exit.txt
```

Both status checks should be empty before execution. Logs and the exit record stay under ignored `.work/` so they do not dirty source identity. Capture the verifier's exit immediately, before another command replaces it. Preserve a previous attempt's log and exit record under a distinct ignored attempt folder before retrying; do not overwrite failures or combine partial results from different attempts.

Success requires exit 0 **and** a final qualifying run record: two VALID, accepted repetitions with matching forced outcomes, successful teardown and empty remaining container/volume/network lists. Source S, canonical verifier and guard subject must match [the claim register](V3_CLAIMS.md). Generated evidence is under `.work/v3/gate-a/gate-a-<timestamp>/`. Read that run's `summary.json`, `cleanup.json` and both reports; a console success line alone is insufficient. The original handler must reproduce two orders, while the reference passes applicable rungs and every control fails for its intended defect.

New run IDs/timestamps, raw report hashes and built image IDs may differ. The historical comparison is about source identity and tested outcomes, not bit-for-bit container reproducibility. Record actual runtimes: the accepted historical experiment had candidate Node 22.18.0 and controller Node 24.11.0; it did not run every process on Node 22.

If Docker fails, a run times out or cleanup cannot be established, retain logs and report INVALID/HOLD. Inventory only the run's labelled resources; never delete unrelated containers, volumes or databases. No pass is inferred from infrastructure failure. Any new full execution requires its own execution authorization and must not contend with W2 validation.

## Limits

This recipe rechecks a fixed P1/T1 synthetic experiment. It does not qualify arbitrary hostile candidates or AI-generated changes. No credentials, real capture or model call are needed for the lab; do not populate or read credential files just to build it. Preserve genuine Sandbox observation versus synthetic lab labels throughout a demonstration.
