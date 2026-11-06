# G1 frozen evidence audit — November 5, 2026

Scope: source/evidence inspection only. No tests, provider calls or model calls were rerun for this audit. `VERIFIED` below means independently checked file bytes, Git state, source or stored evidence contents. Historical executions remain `RECORDED_NOT_REPRODUCED` in this audit; their logs are not fresh runtime qualification of subsequent changes.

## Frozen identity

Repository `C:/projects/ordertruth`, branch `fixes`, HEAD `02e06ec7475bab2f0365144aea65655e31681a61`. Recorded public-main ref: `eb39f1549b34f67f2acb67a52d87e28be62cfb1b`. These are local refs, not a new GitHub observation. Frozen report and status are retained under `.work/runs/g0-g3-20261105/freeze/` without modification.

VERIFIED SHA-256:

| Artifact | SHA-256 |
| --- | --- |
| `freeze/source.zip` | `3ffad84a4e297b51031d52ab134b368997104cf32b8a072a1c28057df7b5eef4` |
| `freeze/manifest.json` | `36dabe5d8e30a4dffe9bfb8fdd245ea4271d51f4c7b3bdb64a6ebb8850af1264` |
| `freeze/tested-source-manifest.json` | `5dc1a61d2e5452154439049a461f87bb885deb28f04427e14dd848ff8d21dbaf` |
| `.work/runs/handoff-20261105/implementation.patch` | `ed01fbdc0774263a316d7f9cdcdbc357e11d61a57bc69d8d274d8dcce47509f1` |

The frozen manifest contains 435 files. All 30 inspected Lab/guard/adapter/journal/test files currently match their frozen-manifest hashes. This statement excludes other concurrently edited files.

The tested-source manifest is **not** byte-identical to the frozen checkout for 24 of the 25 preexisting Lab/guard files. VERIFIED explanation: replacing current LF line endings with CRLF reproduces every one of those 24 tested hashes exactly. `packages/guard/sql/guard-v1.sql` already matches exactly. There is no semantic source change in those comparisons. The new adapter, journal, adapter tests, matrix test and journal integration test match their tested hashes exactly. Do not describe the whole current checkout as the exact tested byte image.

| Source | Frozen/current SHA-256 | Tested SHA-256 |
| --- | --- | --- |
| `packages/lab-merchant/src/v-a/original.ts` | `0100bab1d8565552fd9d156d72da421e9bbad390ba079a6cc6273f98b57eac3d` | `6ce20a994e8ee62561dec8fb2a157d3f9381bce836464062d70f6e7099b0a5e6` |
| `packages/lab-merchant/src/nc/nc3-key-on-path.ts` | `6b36646d9ad5166f73de0df7cf2b60db351bb4d1167fa07e375514c7aeabc0a3` | See tested-source manifest; CRLF-only difference |
| `packages/lab-merchant/src/v-a/reference-fix.ts` | `6413aea8007a5dd17f712dc591ddaa9085a07966a6e3ccda744b6b7fc064df11` | `afc4bad905c061eb4045891eefa93aa961191f5b2bc2e91ef818aa06845c0847` |
| `packages/guard/src/guard.ts` | `d0566d95fe21d7b556988f6c656fbc9e893c1adcade4417b846483efd8920c82` | `a5f5f80b5625704e571d196788143eb06c7d920e70ed0a58eb59c8b10315a927` |
| `tests/v3-postgres/defect-matrix.integration.ts` | `f5c395d8b53c2422f8d6a96d5d68cf037dfb137ef0744b56fdcffd79a8cd43b0` | Exact match |
| `src/merchant/lab-webhook-adapter.ts` | `d6baf568df797d9e18f20f8a58914acd20f21925f4b50d473bc0a9640f6c3bdf` | Exact match |
| `src/merchant/lab-webhook-journal.ts` | `6a0de8794bd063a1b2a3eae606ee764ba8cfdefe64ee55dd6b21cd0b336bbe5b` | Exact match |

## Exact matrix and observed evidence

Suite: `Phase 1 frozen merchant defect matrix (synthetic PostgreSQL)`. All observations below come from `.work/runs/handoff-20261105/node22-matrix/` and the recorded Node22 PostgreSQL log. Provenance is `SYNTHETIC_FIXTURE`; no row establishes PayPal capture or webhook causation.

| Exact test name | Expected orders | Recorded orders | Raw trace filename |
| --- | ---: | ---: | --- |
| `race: sequential` | 1 | 1 | `race-sequential.json` |
| `race: overlap` | 2 | 2 | `race-overlap.json` |
| `cross-path: sequential` | 2 | 2 | `cross-path-sequential.json` |
| `cross-path: overlap` | 2 | 2 | `cross-path-overlap.json` |
| `corrected: sequential` | 1 | 1 | `corrected-sequential.json` |
| `corrected: overlap` | 1 | 1 | `corrected-overlap.json` |
| `corrected-two-captures: sequential` | 2 | 2 | `corrected-two-captures-sequential.json` |
| `corrected-two-captures: overlap` | 2 | 2 | `corrected-two-captures-overlap.json` |

VERIFIED source behavior: `original.ts` checks intent existence, awaits `afterCheck`, then inserts. NC3 checks `(intent_id, created_by_path)`, so sequential return/webhook calls can both insert. `reference-fix.ts` invokes `guard.createOrderOnce`. Overlap tests hold a PostgreSQL advisory lock and wait until two real lock waiters exist before release. This is a selected execution schedule, not natural webhook timing.

Vulnerable-writer traces retain path identity, capture/intent identity, SELECT results, INSERT attempts/results, barrier arrival and final rows. Corrected-writer traces retain handler/capture/intent identity, barrier arrival, guard outcomes and final rows; they do **not** instrument every internal guard SQL statement. Guard evidence/transaction tests provide separate evidence; do not claim the eight trace files alone contain full internal transaction traces.

Recorded successful command in `current-targeted.sh`, run from `/tmp/current` with a disposable local PostgreSQL and synthetic credentials:

```sh
node node_modules/vitest/vitest.mjs run --config vitest.v3-postgres.config.ts
```

The wrapper supplies `V3_PG_URL` and redirects stdout/stderr to `/evidence/current-node22-postgres.log`; it then copies matrix/webhook traces into the evidence directory. The script is execution provenance, not a new command executed during this audit. The earlier `current-tests.sh` has the same PostgreSQL command after a full offline run; that full offline run failed before reaching it. Do not attribute the successful PostgreSQL output to that failed script invocation.

RECORDED_NOT_REPRODUCED output, `current-node22-postgres.log`: `Test Files 11 passed (11)`, `Tests 100 passed (100)`, duration `165.52s`. SHA-256: `92cefab1cf29c2fae7d5432a552f49b7aab9d24fb19812886571472bf50d1683`. Its log includes all eight named matrix cases plus three journal integration cases. The historical host `v3-postgres-final.log` reports 97/97 and `journal.log` separately reports 3/3; these are separate runs, not one 100-test execution.

Failed probes are preserved: `matrix.log` and `matrix-retry.log` each report two failures and six successes. The latter explicitly records `IDENTITY_CONFLICT` when a second capture was passed under the same intent. Their hashes are respectively `0ecbbf48eacd981c20218c0f819a381207fbdbee35fbc6c26b8c4ef7e289114e` and `2961f644f0d178c81c219979ff1ba36694db5faabdc421c0d3cc994acdfe753a`. The successful two-capture control uses **two intents** (`SYN-INT-1`, `SYN-INT-2`), not two captures fulfilling one intent. Both final trace files expose those identities.

## Correctness boundary of the existing fix

VERIFIED from `packages/guard/sql/guard-v1.sql`, `src/identity.ts` and `src/guard.ts`:

- The primary key is `(merchant_id, operation_kind, obligation_key)`. The generated obligation identity includes key version, Sandbox environment, payee merchant, capture and `primary` unit. It is not keyed on handler path or webhook event ID.
- A second unique index, `obligations_p1_intent`, covers `(merchant_id, intent_id, unit)` for `CREATE_ORDER`. The fix is **both capture-scoped and intent-restrictive**.
- A different capture on an already claimed primary intent returns `IDENTITY_CONFLICT`, with evidence rule `SECONDARY_INTENT`; an incompatible fingerprint on the same primary obligation also conflicts. Neither is silently reused as the same purchase.
- Separate purchases with separate intents/captures are supported by the recorded controls. Split fulfillment, partial/multiple capture per intent, and arbitrary merchant lifecycle compatibility are NOT TESTED and are outside this P1 contract. Do not market this as universal capture uniqueness alone.

The existing tests named `second capture for same intent conflicts via partial index`, `distinct intents both create`, `rejects a second capture for the same intent through the partial unique index`, forged-MAC/binding tests, registered-statement rollback tests and restart tests are included in the stored 100-test log. Repeated event IDs belong to separate journal tests, not the defect matrix itself. Full production/RBAC/cross-organization qualification is not established by these synthetic merchant tests.

**Legacy gap, VERIFIED by source inspection:** every guard outcome carries `LEGACY_CHECK_ABSENT`. The V-A configuration has `createOrder`, `orderLocator` by newly returned order ID and `intentLocator`; it has no query to discover preexisting unguarded orders by capture/intent before the first claim. `shop.orders` deliberately lacks capture/intent uniqueness. Therefore the guard protects participating guarded calls; it cannot be claimed to prevent a first guarded order duplicating a preexisting unguarded order, or a later unguarded writer bypassing it. Existing legacy orders require separate migration/reconciliation policy and independent tests. No migration or new uniqueness constraint was introduced for this audit.

## Exact delta boundaries

VERIFIED read-only Git inspection:

```text
git diff --name-status HEAD -- packages/lab-merchant packages/guard
  (empty: no tracked working-tree delta)
git diff --stat origin/main HEAD -- packages/lab-merchant packages/guard
  25 files changed, 1434 insertions(+)
git ls-tree -r --name-only origin/main -- packages/guard packages/lab-merchant
  (empty: both packages absent from recorded public main)
```

Those 25 paths are exactly the 10 `packages/guard/` and 15 `packages/lab-merchant/` entries in frozen `manifest.json`. The full reviewable package diff is reproducible without mutation with `git diff origin/main HEAD -- packages/guard packages/lab-merchant`; it is not a change made by this handoff. The existing public `src/merchant/reference-merchant.ts`, `fault-injection.ts` and `postgres-scenarios.ts` have no delta from recorded public main to experimental HEAD.

The adapter and journal are new untracked files, absent from both HEAD and public main. Plain `git diff` therefore omits them. Their exact frozen bytes are in `source.zip`, their hashes above, and their additions are in the preserved `implementation.patch` (which also contains other session files). Neither is part of public-main or a committed release candidate. The journal serializes event IDs and atomically commits receipt plus vulnerable-writer queries routed through its transaction pool. Corrected guard writes use a separate transaction and depend on capture-idempotent reuse after a journal retry; there is no claim of a distributed atomic commit.

G1 evidence supports the two selected defect demonstrations and this constrained reference fix. G2 live causation remains PENDING AUTHORIZATION and requires a separately reviewed composition. No provider capture, registration, tunnel, model usage, hosted change, commit or publication was performed for this audit; external spend ₹0 and model calls 0.
