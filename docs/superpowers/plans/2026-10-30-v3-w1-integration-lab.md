# OrderTruth v3 — W1 Integration Lab implementation plan

Date: 2026-10-30. Baseline: `fixes` / `fc85ac3`. Revision 2: W1-01/W1-02 review corrections.
Status: **PROPOSED — awaiting Claude review before any implementation.** The owner chose review-before-build. W1's judge UI/build scope is authorized; Git writes, CI changes, deployment, live calls and later work streams are not.

## Goal and bounded checkpoint

Deliver W1 checkpoint 1 end to end: a local accepted Gate A run becomes public static evidence, the frontend build validates it, and a read-only Integration Lab displays the actual results. Stop with `.work/v3/w1/checkpoint-1/REPORT.md` for Claude review and owner commit. Do not turn an internal coding step into an unreviewed next checkpoint or begin W2 alongside it.

The roadmap is `2026-10-30-v3-post-gate-a-roadmap.md`. Binding contracts are the v3 spec §§11/13, the handoff §§4–7 and `AGENTS.md`. This plan adds a publication layer, not SDK or verifier behavior.

## Verified starting facts

- Gate A and clean reproduction PASS for fixed V-A / P1 / T1 / TEST authority.
- Source S: `fc85ac3db1388bd84a3a55b8198d9dc3b2ad6c86`.
- Input run: `.work/v3/gate-a/checkpoint-4/reproduction-evidence/`, run ID `gate-a-2026-10-30T15-58-19-399Z`.
- Accepted verifier manifest: `b9e880ee0970c0bd0fb4bbd63086dc86beab1e179690fb4fe52f594309e44f72`; guard tree: `7bef5fc5e0c5eaa5ac9bdcf16f6fa7c8bca86f5df83637d2e3c80f4e61f70f42`.
- Existing judge is a vanilla TypeScript DOM application under `web/judge`; Vite builds `dist/judge`. Static serving already exists; Vercel only rewrites `/api/*`.
- The repository already has TypeScript, Zod, Vite and Vitest. No new dependency, package script or lockfile change is necessary.

## Architecture decisions

1. Use a separate `/lab/` page within the judge's Vite build, linked from its header. Reuse the design system, but leave case/session/investigation handlers unchanged. The lab can open without authentication or backend connectivity.
2. Publish the **committed clean reproduction**, not the older dirty-tree baseline. Keep both raw redacted reports, their byte hashes and the derived proof. The page labels the execution as local containers; it does not invent a CI run.
3. The build validates files, recomputes two-run qualification and embeds the validated proof/hashes. There is no runtime fetch of neighboring data/hash files and no endpoint to execute/apply/verify code.
4. Source commit S is the commit actually verified. Publication/build commit P comes from build metadata and is never stored inside the manifest that P commits. Local uncommitted previews are labeled as such; never present HEAD as a clean publication when inputs are dirty.
5. Hash equality proves publication consistency, not independent attestation of execution. The page says this and gives the actual `pnpm v3:verify:gate-a` reproduction command.
6. Do not touch manifest-pinned Gate A files. In particular, leave `package.json`, the verifier/guard, their Dockerfiles, `tests/v3/**` and the accepted manifest unchanged. New tests live at `tests/lab-*.test.ts`.

## Proposed file scope

| Files | Purpose |
|---|---|
| `packages/assurance/src/lab-record.ts` | Pure validation/derivation of a public Gate A proof; reuse the existing pure report qualification rules |
| `packages/assurance/src/lab-files.ts` | Bounded filesystem publication/loading, byte hashes and path/symlink checks |
| `packages/assurance/src/gate-a-inputs.ts` | Reviewed, source-code pins for the selected historical run's identity and four authoritative input hashes; not values supplied by its artifact manifest |
| `scripts/publish-lab-evidence.ts` | Explicit operator CLI: input run directory → deterministic artifacts; no calls, containers, Git writes or implicit execution |
| `docs/evidence/lab/manifest.json` and named artifacts | Both run reports, final summary, final cleanup, frozen source verifier manifest, reference source comparison and derived proof |
| `scripts/lab-build.ts` | Validate publication artifacts and provide build-embedded proof, artifact hashes and build identity |
| `packages/assurance/docker/w1.Dockerfile` and its dedicated `.dockerignore` | Separate disposable Node22 W1 validation image; never reuse/replace Gate A's historical validation images |
| `scripts/validate-w1.ts` | Build a permitted-input source snapshot, build the W1 image, verify snapshot identity in-container, run bounded checks and record cleanup/image provenance |
| `vite.judge.config.ts` | Add the lab HTML entry and validated static data/assets; disable credential-file dotenv loading |
| `web/judge/lab/{index.html,main.ts,view.ts,style.css}` | Read-only semantic view and its entry point |
| `web/judge/main.ts` | One ordinary header navigation link, not a state-machine rewrite |
| `tests/lab-{records,build,ui}.test.ts` and a small DOM fixture if needed | Test each behavior before implementation, including real build rejection |
| `docs/evidence/lab/README.md` | How the artifacts were produced, their trust limits and how to regenerate |

Names may be consolidated if the same boundaries stay clear. Any additional scope is a reported deviation. No changes to the hosted API, existing judge workflows, `.github/workflows`, deployment config or existing evaluation corpora are proposed.

## Artifact contract

The publication manifest is versioned. It lists bounded relative filenames, SHA-256 of **actual file bytes**, artifact kind, source commit S, local execution/run ID and image identities. It never lists its own hash or includes its future publication commit. Unknown versions, missing/duplicate roles and path escapes fail.

The public input set is explicit. All seven artifact roles below are mandatory; the manifest is the eighth JSON file and does not hash itself:

| Role | Published filename | Origin |
|---|---|---|
| Report 1 | `gate-a-run-1.report.json` | Selected run's `run-1/report.json`, byte for byte |
| Report 2 | `gate-a-run-2.report.json` | Selected run's `run-2/report.json`, byte for byte |
| Final qualification summary | `gate-a-final-summary.json` | Selected run's `summary.json`, byte for byte |
| Authoritative final cleanup | `gate-a-final-cleanup.json` | Selected run's `cleanup.json`, byte for byte |
| Source verifier manifest | `gate-a-verifier-manifest.json` | Public verifier-manifest Git object at source S |
| Reference source comparison | `gate-a-reference-source.json` | Deterministic comparison of the original/reference public modules at S |
| Derived proof | `gate-a-proof.json` | Deterministic derivation from the validated inputs above |

The successful summary/cleanup files are already bounded, redacted controller output; their fields and byte hashes survive publication. Neither is reconstructed from manually copied booleans. New runs with unsupported shapes require a reviewed schema change rather than silently dropping failure fields. No build reads the private source archive after export.

Artifact details:

- The two original redacted `run-N/report.json` files, copied byte for byte with their original hashes. Do not publish claims logs, arbitrary SQL output, credential files or merchant/provider records. Scan the selected files before adding public artifacts.
- The exact final `summary.json` and `cleanup.json` from the same selected run. The summary supplies run/source identity, both recorded acceptances, comparison and provisional/final qualification fields; cleanup supplies `ok`, `errors`, `downExit` and the actual `remaining` container/volume/network lists. Their equality and semantic checks are specified below.
- The verifier manifest as recorded at S, read only from the explicit source commit's public Git object. Its canonical manifest hash must equal both reports' verifier hash.
- A deterministic source comparison, labeled `reference-source-comparison/v1`: original/reference module paths, normalized source text and their hashes at S. These hashes must match the frozen source manifest entries. Gate A selected a reference implementation directly through its harness; it did **not** record an applied migration patch. Consequently `candidate.diffSha256` is null with `diffStatus=NOT_RECORDED_GATE_A`, and `referenceComparisonSha256` identifies this separate comparison. Do not manufacture an “applied patch” or equate a module replacement with a working migration.
- One deterministic Proof of Protection containing both run summaries. A pure derivation from validated inputs is repeated at build time; a manually edited proof cannot disagree with its reports while still passing the build.

The proof includes: contract `OT_V3_OBLIGATION` / `0.1.0`; SDK `0.1.0-gate-a`; V-A; origin `REFERENCE_FIX`; P1/T1; source/run/report identities; verifier/subject hashes; image identities; original expected failure; reference ladder; all nine NC outcomes with intended checks and evidence kinds; seeds/reproduction flags; two exercised T1 paths; historical coverage `NOT_TESTED`; fixture/TEST provenance; and all relevant limitations.

Do not report a Gate B policy gate as passed: it is `NOT_APPLICABLE_REFERENCE_FIX`. Do not infer human approval from test success. Include the **recorded Gate A review PASS** with the hash of the local Gate A result supplied as provenance, clearly described as a recorded decision rather than a cryptographic reviewer attestation. W1's publication approval is separate and pending this checkpoint's review/owner commit.

Required inherited/additional limits: fixed lab only; candidate can mutate records; container reuse/timeout gaps; synthetic fixture with no PayPal data; not deployed/production-verified; undiscovered paths not covered; external exactly-once effects unsupported; no AI-value conclusion. Coverage means only the two exercised V-A paths, not general merchant discovery.

## Admission and build rules

Before public export, require two structurally valid full reports and a consistent final summary/cleanup record. Recompute qualification; require expected NC failures, supported candidate runtime/PG version, same clean source commit/manifest/subject across reports, no partial run, cleanup exit0 and empty resource lists. Never trust `accepted:true` or `qualifying:true` alone.

### W1-02: all qualification and cleanup checks use committed public inputs

At both export and build, apply these checks to the **published** report/summary/cleanup files, not to values copied into the derived proof:

1. Schema-validate all four records, including the complete cleanup result. Require report run IDs to be exactly `<summary.runId>-run1` / `-run2`; the publication manifest must name that run ID and the same clean source S.
2. Bind both report environments and the summary environment on source commit, candidate/controller runtimes, PostgreSQL version, image identities, verifier-manifest hash and guard-subject hash. Do not accept a report from a different source/run under a matching-looking filename.
3. Recompute `qualification(reports, {requestedRuns: 2, filtered: false, expectedManifestSha256})`. Require both acceptances true, VALID/VALID and matching forced outcomes. Compare recorded summary validity, acceptance, comparison, status/NC summaries and qualification fields to the recomputed facts. `partial` must be false, reasons empty, and final qualification true.
4. Require published cleanup `ok === true`, `errors` empty, `downExit === 0`, and **all three explicitly present** resource arrays empty. Missing/unknown lists are not zero resources. The final summary's full cleanup object must equal the separate authoritative cleanup record. Require final qualification to equal recomputed verification success **and** cleanup success.
5. Verify the artifact manifest's byte hashes, but do not let it choose the reviewed historical inputs. W1's fixed accepted-run allowlist in `gate-a-inputs.ts` pins S, run ID, verifier/subject identity and the four raw file hashes below. This small source-code change is included in W1 review. It prevents rewriting a failed cleanup plus neighboring manifest/proof into a clean result. A different accepted run requires a separately reviewed allowlist update.
6. Derive the proof again and compare it with the published proof. No admission decision is based solely on its flags. All these checks work from a fresh checkout without `.work`, the original machine, a backend or a network request.

Reviewed historical-input hashes (SHA-256 of actual source bytes, freshly checked during this revision):

| Source record | SHA-256 |
|---|---|
| `run-1/report.json` | `b9e30b8cc40323950768b03caff367feeb14e5ac287e85f819262127cefd44d9` |
| `run-2/report.json` | `8e312d86103af1cd1a8cd7c4695940954ffcbc9463bd4f4dd4e5d5194c6fce03` |
| `summary.json` | `23ee9fb1742797aa445855db48ae35482065b437c088ef31fc3430d97638116d` |
| `cleanup.json` | `f43e787ed824a362e2748770897b5af7cab733944ef84c215d723f3a6dabcefe` |

Negative controls must reject: omitted cleanup; a true summary paired with failed/nonzero/nonempty cleanup; fabricated clean flags; missing inventory arrays; mixed run/source reports; and edits to all neighboring artifact hashes without changing the reviewed source-code pins. Pure fixture-level semantic tests use explicit fixture pins so they fail for the semantic defect rather than merely the historical byte pin. Real-bundle tamper tests must identify their intended integrity/binding rejection.

This remains consistency with a reviewed publication, **not independent execution attestation**. An actor who changes the trusted validation code and its reviewed pins can define a different publication; this build does not claim to detect that with self-supplied hashes. No cryptographic authenticity of Docker execution is invented.

Raw input schemas must fail clearly on malformed data before calling report logic; never print entire untrusted reports in errors. Permit only the explicitly named input files. Bound sizes/counts, reject symlinks and reject publication paths outside the intended directory **before** reading them. Publication filenames are fixed/allowlisted, never taken as arbitrary paths from report content.

The loader checks every artifact's byte hash and semantic binding, including source-comparison and source-manifest references. Missing artifacts, unsupported versions, changed reports, failed NCs, missing checks, changed source identity or a fabricated proof fail the build. Resolve records through build-embedded validated data, not client-provided hashes.

For build identity, use read-only Git metadata when available. The isolated W1 image receives explicit **public** build-commit/dirty and source-snapshot metadata generated by the validation driver; it contains no `.git` and needs no owner-configured environment variable. Missing identity must be shown as unavailable rather than invented. A normal clean publication must display the actual full commit; a local preview must display its dirty state.

## Judge view

- Heading “Integration Lab”; exact spec labeling: “Reference integration, verified offline in an isolated container, using a synthetic PayPal-shaped fixture (no PayPal data). Separate from your judge case, which uses a genuine PayPal Sandbox observation.”
- Make the fixed-lab scope and locally recorded execution clear above the results. Source commit/run and publication/build commit are distinct visible fields.
- Show the original's two-order race as an **expected control failure**, the reference fix's ladder as tested results, and all nine caught NCs with their intended reason. Do not color an expected control failure as a failed overall experiment.
- Show T1 exercised paths, limitations, evidence hashes/image identities and reproduction instructions. Use native details/tables for technical evidence. All data becomes text content, not unsanitized HTML.
- Navigation back to the judge experience is an ordinary link. No capture, repair, agent, “run verification”, sign-in or mutation control is added to the lab.
- Use semantic headings/table captions/column headers, visible keyboard focus, skip navigation and responsive wrapping/scrollable tables. Test narrow/mobile and keyboard use in a real browser; explicitly record any unavailable browser/a11y checks.

## Test-first execution sequence

Write and observe the intended failure for each behavior before implementing it. Missing-module failures alone do not establish a false-pass regression; once a minimal seam exists, demonstrate the meaningful rejected case.

1. **Proof derivation/admission:** accepted fixture produces exact metadata; failed/incomplete/partial runs, unexpected NC defect, dirty/mixed source, omitted/failed/fabricated cleanup, malformed shape and contradictory proof cannot publish. Exercise the W1-02 semantic checks independently of byte-pin failures. Verify unknown/missing review/policy/coverage states remain honest. Then implement pure contracts/derivation.
2. **File integrity/publication:** fixed byte vectors, no source/hash self-reference, deterministic outputs, path traversal/symlink/missing/duplicate/oversize artifacts rejected before access. Test a valid proof modified while neighboring metadata stays unchanged. Then implement bounded loader and explicit exporter.
3. **Real evidence:** export the clean archive at S; inspect/scan only the proposed public artifacts; record every source and output hash. Reject any attempt to use the failed reproduction or a dirty-tree run as the committed source.
4. **Build:** an actual judge build with a tampered artifact must fail for its hash/binding defect, not an unrelated build/Git/tool problem. A valid temporary artifact set must build; publication P is separate from S and dirty preview labeling is tested. Prove the separate Node22 image contains the current W1 source snapshot, not an older cached tree. Then wire checked build data and both HTML entries.
5. **UI:** test real record headings, expected-original-failure wording, nine NCs, T1 paths, source/publication identity, required limitations and synthetic/Sandbox split; render an injected markup string as text; prove the lab makes no API calls. Then build the lab view and one judge navigation link.
6. **Regression/QA:** both typechecks; targeted tests; existing judge UI tests; full host suite; all existing frontend builds; Node22 validation; real-browser direct `/lab/`, keyboard/mobile and back-link checks. Do not declare WCAG certification from a DOM fixture or replace a failing old test with a weaker one.
7. **Mutation proof:** on isolated scratch copies, bypass a hash check and acceptance/cleanup check; the intended regression must fail. Preserve original bytes throughout validation. Keep outcomes/hashes under `.work/v3/w1/checkpoint-1/`.
8. **Review stop:** write the full report, limitations/deviations, Git status/diff and owner commit commands. Send through the owner to Claude; no next stream/checkpoint or agent Git write.

## Runtime validation and avoiding hidden prerequisites

### W1-01: separate, disposable Node22 image with exact W1 inputs

Do **not** use an old Gate A qualification image plus a data mount as W1 build evidence. The dedicated W1 Dockerfile/image contains the complete source snapshot being evaluated, including the new assurance modules, validation/export scripts, UI and modified Vite configuration.

The planned entry point is `node --import tsx scripts/validate-w1.ts`. It must:

1. Create a fresh sanitized Docker context under `.work/v3/w1/checkpoint-1/`. Copy only approved root package/lock/workspace/compiler/Vite/test configs, ordinary permitted files from `src/`, `web/`, `scripts/`, `packages/`, `tests/`, and the public `docs/evidence/lab/` artifacts. Exclude credential/private paths **before reading/copying**: `.env`/`.env.*`, `.git`, `.work`, host `node_modules`, build outputs, credentials/secrets and private key files. Reject symlinks. Do not copy the repository wholesale and then delete sensitive files. Missing imports outside the allowlist fail rather than being supplied from host mounts.
2. Record every copied source/config/artifact path and raw-byte SHA-256 in a sorted `source-snapshot.json`; compute its tree digest. Generated snapshot/build-identity metadata is explicitly outside that digest to avoid self-reference. Record host HEAD/dirty state and the snapshot digest separately. This identifies the actual permitted build tree, including uncommitted W1 files, rather than pretending HEAD alone identifies it.
3. Build `packages/assurance/docker/w1.Dockerfile` from that context, using `node:22.18.0-bookworm-slim`, pinned pnpm11.4.0 and `pnpm install --frozen-lockfile`. Copy **the current snapshot and public artifacts into the image**. Use a distinct `ot-v3-w1-validation:<snapshot-prefix>` tag and capture the immutable image ID; record the resolved base image identity and pinned versions. Existing dependency cache layers are allowed, but the source COPY/hash verification must match the current snapshot.
4. Before testing, recompute all source hashes inside the image and require the expected tree digest. Include a regression in which changing a W1 source file changes the snapshot and the code observed by validation; the prior snapshot/image cannot satisfy it. A hash mismatch makes supported-runtime validation fail.
5. Run as non-root with bounded time/process/memory limits and no runtime network, Docker socket, `.git`, credentials, private evidence or source-directory mounts. Use only declared temporary/cache/output locations for Vitest/Vite writes; disable dotenv file loading. Run both typechecks, `tests/v3` plus the new W1 tests, judge/owner builds and frontend packaging against that exact snapshot. Tests requiring deliberate build tampering use temporary copies of committed public inputs, never real credential files.
6. Export generated judge/owner/dist assets to an explicitly declared checkpoint-owned output directory (a writable **output-only** mount is allowed; no source/private directories are mounted). Hash that output and use it for the packaged-site/browser checks. Capture command statuses, test counts, snapshot digest, image ID, base identity and logs under the W1 checkpoint. Bound teardown and verify no W1 containers/volumes/networks remain. Do not remove or replace Gate A's historical images or modify its pinned Dockerfiles/manifest.

Record the **W1 validation image** separately from the **historical Gate A candidate/proxy/PostgreSQL images** in the published evidence. W1 compilation does not re-attest the earlier verifier execution or substitute new image IDs into its reports. No environment variables, new dependency or service setup are required from the owner.

Confirm the judge HTML and `/lab/index.html` appear in `dist/judge`, and owner packaging remains intact. Serve the **actual packaged `dist/judge` tree**, not Vite's development server, through a local read-only static server using the existing static-serving behavior. Direct GETs to `/`, `/lab/`, `/lab/index.html` and `/owner/`, and the script/style asset URLs in their HTML, must return the expected files. Exercise judge-to-lab and back navigation in the packaged browser check; existing judge session/recovery tests must remain green. No live backend, PayPal action, CI verifier job or deployment is required. If Docker cannot support validation, finish independent checks and report supported-runtime verification BLOCKED instead of substituting host success.

### Public-source availability before external reproducibility claims

The review reports that the connected remote branch is older than local S; remote availability is **NOT_VERIFIED** by this plan. Before saying an outside reader can reproduce the experiment, perform a read-only, unauthenticated check that the exact full source commit S is reachable from the repository URL actually shown in the instructions. Record repository URL, commit, UTC check time and observed result. Also identify the clean publication commit P when it exists.

Do not silently push or change repository visibility to satisfy this check. If S is not publicly reachable, the local preview must explicitly say “source availability not verified” or “local checkout only”; the checkpoint report marks external reproduction/public release BLOCKED. Local implementation/review can continue, but no externally reproducible/public-release-ready claim passes until the owner makes the source available and the check succeeds. Availability is a dated observation, not a promise that a repository can never become unavailable.

## Acceptance and stopping rules

W1 is ready for review only when the actual clean-reproduction records are displayed; all integrity/semantic negatives fail for their intended reason; both source and publication identity are truthful; two lab pages build alongside the unchanged owner flow; keyboard/mobile checks and existing regressions are evidenced; and no new dependency, secret, live/model call, deployment or Gate A drift occurred.

If artifacts cannot be made public safely, build integrity cannot bind them, or the source/publication identity is ambiguous, stop with a concrete blocker. Do not replace the real result with a fixture or add a fake success state.

No environment variables, API keys or service signups are needed from the owner now. Gate A evidence is already present locally. After W1 review PASS and owner commit, propose W2's separately reviewed trust-boundary plan. Live W3 remains explicitly unapproved.

## Review focus / explicit adaptations

Claude should probe hardest for: publication false passes; wrong source or stale cleanup accepted; self-referential commit/hash fields; raw/private data leakage; and unchanged judge session/repair behavior.

Adaptations requiring plan review: local execution provenance instead of optional CI; an explicitly unavailable migration-diff field plus a separately hashed reference-source comparison; recorded review provenance rather than an independent attestation; a separate static entry rather than a SPA rewrite; and the explicit authoritative-public-input pins/dedicated W1 snapshot image added by this review. These preserve the spec's evidence split while matching the Gate A artifacts that actually exist.
