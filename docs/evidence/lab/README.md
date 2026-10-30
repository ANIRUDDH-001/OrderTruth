# Integration Lab: fixed Gate A publication

These are static records of the **locally reproduced**, synthetic P1/T1 V-A experiment. They are separate from the hosted judge case's genuine PayPal Sandbox observation. No PayPal data or model-generated migration is claimed here.

- Verified source: `fc85ac3db1388bd84a3a55b8198d9dc3b2ad6c86`.
- Run: `gate-a-2026-10-30T15-58-19-399Z`, two accepted matching repetitions.
- Origin: human-written `REFERENCE_FIX`; the original merchant's forced race is an expected failure with two orders.
- Historical verifier manifest: `b9e880ee0970c0bd0fb4bbd63086dc86beab1e179690fb4fe52f594309e44f72`.
- Guard subject: `7bef5fc5e0c5eaa5ac9bdcf16f6fa7c8bca86f5df83637d2e3c80f4e61f70f42`.
- Public source availability is **not verified**. Reproduction instructions assume a local checkout containing the source commit. Do not describe an external public clone as available until a dated unauthenticated check succeeds.

## What is checked

`manifest.json` hashes seven artifacts by their actual bytes: two run reports, final qualification summary, authoritative cleanup result, source verifier manifest, reference source comparison and derived protection proof. It does not hash itself or contain its own publication commit.

The exporter/build recomputes qualification from the two reports, verifies source/run/runtime/image identity, and cross-checks the summary with successful authoritative cleanup and empty resource lists. Four historical raw-file hashes are pinned in reviewed source code independently of the publication manifest. Editing a success flag or rehashing adjacent fabricated records cannot authorize a new historical result.

The proof is derived again at build time. The reference source comparison is **not** an applied migration patch: Gate A selected the reference implementation directly, so `candidate.diffSha256` is null and the unavailable status is explicit. The recorded Gate A review hash is provenance, not an independent reviewer/execution attestation.

Build-embedded hashes establish consistency with these recorded files. They do not independently prove the Docker execution was genuine. The SDK/verifier experiment is the independent reproduction path.

## Build and inspect

No credentials, private evidence or `.work/` directory are needed to build this committed publication:

```powershell
pnpm install --frozen-lockfile
pnpm build:frontend
```

The packaged judge output contains `/lab/index.html` and `/lab/evidence/*`; the judge header links to `/lab/`. The lab performs no API calls or code/payment operations. Source commit S and the publishing build commit are displayed separately; uncommitted or unavailable build identity is labeled honestly.

For supported-runtime validation of **current W1 code**, use the dedicated disposable image driver:

```powershell
node --import tsx scripts/validate-w1.ts
```

It constructs an allowlisted source snapshot, records raw file hashes, builds a separate Node22.18.0/pnpm11.4.0 image, verifies the snapshot inside it, then runs typechecks, W1/Gate A offline tests and frontend packaging/direct-route checks. Runtime has no network and only declared temporary/cache/output locations are writable. Logs, image/base identities, source identity and cleanup are written under `.work/v3/w1/checkpoint-1/`; they do not replace historical Gate A image identities.

## Reproduce the historical experiment

With Node22.18.0, pnpm11.4.0 and Docker's Linux engine, from a local checkout containing source S:

```powershell
git checkout fc85ac3db1388bd84a3a55b8198d9dc3b2ad6c86
pnpm install --frozen-lockfile
pnpm v3:verify:gate-a
```

Require two VALID/accepted matching results and cleanup PASS. Execution timestamps, run IDs and report hashes will differ; compare the forced outcomes. The source commit predates this W1 publication.

The explicit exporter can recreate this publication from its original approved archive:

```powershell
node --import tsx scripts/publish-lab-evidence.ts <approved-run-directory> docs/evidence/lab
```

It never runs a verifier or changes Git. It refuses a different run or different pre-existing output. Publishing a new independently reproduced run requires a reviewed update of the historical pins, not editing the neighboring manifest to bypass them.

## Limits

The current verifier qualifies fixed reference/negative-control code only. Candidate writes can conceal effects or fabricate records; shared-container and CLI-timeout isolation gaps remain. Arbitrary hostile or AI-generated candidates are not qualified. No AI superiority, production deployment, broad merchant compatibility, undiscovered-path coverage, historical coverage or exactly-once external effect is established. P2/T2, consumers, ingest and legacy reconciliation remain deferred.
