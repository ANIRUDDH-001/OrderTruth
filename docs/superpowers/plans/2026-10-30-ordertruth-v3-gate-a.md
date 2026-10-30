# OrderTruth v3 Gate A (P1/T1 feasibility slice): implementation plan, revision 3

**Planning freeze, 2026-10-30:** revision 3 incorporates the four accepted revision-2 corrections. Frozen for the bounded Gate A attempt; reopen only for an executable blocker or correctness finding. This is planning approval only: Checkpoint 0 execution, installations, Docker storage changes, commits and full Gate A implementation remain separately authorized. No runtime claim is established by this document.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. The owner chose **one primary builder, working sequentially**, with independent reviews at Checkpoints 1, 2 and 3. Steps use checkbox (`- [ ]`) syntax.
>
> **Repository rule:** agents never stage, commit or push. Every "Operator" step is done by Prachi or Aniruddh.

**Goal:** prove, in an isolated verifier with independent database assertions, that the v3 obligation engine makes one verified capture produce exactly one matching merchant order. The proof covers the V-A concurrency race, crashes, lost `COMMIT` acknowledgements (including after a process restart) and two tenants. It is a feasibility proof, not a release.

**Architecture:**
- **The SDK slice.** It lives in `packages/guard`: P1, tier T1, the synthetic test authority, the commit-intent journal, commit markers and resolution.
- **The lab merchant.** It lives in `packages/lab-merchant`, and is a real two-handler shop with REF-BUG-1 plus a human-written reference fix. It runs in an unprivileged candidate container.
- **The verifier.** It lives in `packages/verifier`. A trusted controller on the host owns the fixtures, the fault proxy, an observer database role, the rungs and the report. It decides verdicts only from its own SQL and from trusted server logs.

**Tech stack:**
- TypeScript, with erasable syntax only in `packages/*`;
- `pg` 8.23.1, already locked;
- PostgreSQL 18;
- vitest 5;
- Docker Compose (Linux engine);
- Node **22.18.0**;
- pnpm **11.4.0**, through corepack, with the existing `pnpm-lock.yaml`.

No new dependencies. **No lockfile change.**

**Spec:** `docs/superpowers/specs/2026-10-30-ordertruth-obligation-integrity-design.md`. §19 is Gate A. §5.1–§5.4b, §5.3e (resolution order and restart recovery), §5.5 (event IDs), §6.1, §10 and §14 are the contracts used here.

## Execution model (owner decision)

- **One builder, sequential order:**
  1. Checkpoint 0 (environment);
  2. Checkpoint 1: Tasks 1–3;
  3. Checkpoint 2: Tasks 4a → 5 → 4b → 6;
  4. Checkpoint 3: Tasks 7–10;
  5. Checkpoint 4: Tasks 11–12.
- **Independent reviews** happen after Checkpoints 1, 2 and 3, each by a fresh reviewer. A checkpoint with an unresolved correctness blocker doesn't proceed.
- **Each checkpoint report contains:**
  - the files changed;
  - the exact commands run;
  - the observed results, redacted;
  - the evidence paths;
  - the limitations and blockers;
  - the next action.
- **Supported-runtime evidence** comes only from Node 22.18.0 inside containers. Host runs under Node 24.11.0 are development signal and **never** qualify a checkpoint.
- **Reassess** after the first bounded working day. If the infrastructure or the core invariant is still blocked, **hold v3** and return to v2 qualification.
- **Authorization:**
  - Checkpoint 0 creates disposable containers and databases, so it needs its own **execution authorization**. This plan alone doesn't grant it.
  - Docker storage changes are **operator** actions, and must preserve existing data.
  - No step touches the v2 schema, the hosted Neon database, Render or Vercel.

## Global Constraints

- **Gate A scope only:** profile P1, tier T1, one tenant per merchant database, variant V-A, one reference fix.
  - Deferred: P2, T2, `handleOnce`/`consume`, cloud ingest, the heartbeat, legacy reconciliation (every outcome carries the flag `LEGACY_CHECK_ABSENT`), coverage, the hosted view, AI and codemods.
- **No PayPal calls, no model calls, no v2 changes** (`src/**`, `web/**`, existing `tests/**`, the v2 schema and CI).
  - Additive edits only: `tsconfig.json` include, `package.json` scripts, and the new `vitest.v3-postgres.config.ts`.
- **Layout: source directories only, not workspace packages.**
  - `packages/*` have no `package.json` of their own, and `pnpm-workspace.yaml` is unchanged, so the lockfile doesn't change.
  - All dependencies resolve from the root `package.json` and `pnpm-lock.yaml`.
- **Installs:** always `pnpm install --frozen-lockfile` with pnpm 11.4.0 (corepack), never `npm ci` and never `npx` downloads.
  - Tools run with `pnpm exec <bin>`, which uses only local binaries.
  - Containers install with `corepack enable && pnpm install --frozen-lockfile` from a copy of the root `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`. This preserves dependency build policy and includes the dev dependencies the later qualify image needs.
- **v3 database tests** live in `tests/v3-postgres/*.integration.ts`, with their own `vitest.v3-postgres.config.ts`, so the existing CI Postgres job (`tests/postgres/**`) doesn't pick them up.
  - Offline v3 tests in `tests/v3/*.test.ts` **are** picked up by the existing CI `pnpm test`, on Windows with Node 22.18.0. They must open no sockets.
- **Synthetic data only:** the `SYNTHETIC_FIXTURE` authority (`TEST`), with an obvious `SYN-` prefix on every PayPal-shaped ID.
- **Contract and key identifiers:** contract `OT_V3_OBLIGATION` version `0.1.0`; `key_version` 1; operation kind `CREATE_ORDER`; unit `primary`; only `sandbox` accepted.
- **Key encoding (§5.2a):** each part is `length(part) || ':' || part`, joined by `|`, with the prefix `v1|P1|`. `length` counts **code points**, so the TypeScript side uses `[...s].length`.
- **Event IDs:** `sha256(canonical({ domain, merchantId, authority, paypalEnv, payeeMerchantId, operationKind, obligationKey, eventKind, contractVersion[, callId] }))`, with domains `ordertruth.effect-event.v3` and `ordertruth.evidence-event.v3`. They use `canonical` and `sha256` from `src/domain/canonical.ts`.
- **Amounts** are integer minor units, as decimal strings matching `/^(0|[1-9][0-9]{0,17})$/`.
- **Identifiers** are 1–128 code points, with no control characters.
- **Finite, mandatory timeouts:** `lockMs` 5000, `statementMs` 10000, `connectionMs` 5000, auxiliary pool max 2. `createGuard` throws if any is missing or not finite.
- **Routes:**
  - The **operation pool** connects through the fault proxy in the verifier, and directly elsewhere.
  - The **auxiliary pool** (used for the journal, resolution and probes) always connects **directly** to PostgreSQL, never through the proxy.
- **Fault targeting:** `runGuardTx` sends `BEGIN`, `SET LOCAL application_name = 'ot:<BOUNDARY>'` and `COMMIT` as simple-protocol queries. Proxy faults match on that boundary tag, one at a time, never on a global count of `COMMIT`s.
- **Schemas and roles:** `ordertruth_guard`, `shop` and `verifier_oracle`; roles `ot_setup`, `ot_candidate` and `ot_observer`, exactly as Task 9 defines them.
- **Unknown commits** follow §5.3e exactly:
  - the intent is journaled before the effect;
  - the marker, with its `outcome_record`, is written last in the transaction;
  - resolution runs on the primary only, and requires the same postmaster start;
  - a probe proves visibility;
  - the original backend must be proved ended;
  - the marker is read again, fresh, after that;
  - `pg_xact_status` is diagnostic only;
  - the eventual states are `COMMITTED`, `NOT_COMMITTED_ESTABLISHED` and `STILL_UNKNOWN`.
- **Files in `packages/`** are type-checked with `erasableSyntaxOnly`, so no enums, parameter properties or namespaces. They import siblings with `.ts` extensions. The containers run them with Node 22.18.0's built-in type stripping.

## Step 0 findings (read-only, 2026-10-30)

| Check | Result | Status |
|---|---|---|
| Git | `fixes` at `82d851c`; spec amended but uncommitted; this plan untracked | operator commit (Task 0) |
| Node | `v24.11.0`, no nvm | host runs are development signal only. Qualification uses containers. |
| pnpm | global 9.15.0, which errors in this repo; the repo pins 11.4.0 | operator: `corepack enable` (Task 0.1) |
| Docker | CLI 29.4.3; Desktop service **stopped**; Linux engine absent | **BLOCKER** |
| WSL | WSL2; `Ubuntu-22.04` and `docker-desktop` distros, stopped | OK |
| Disk | **C: 4.0 GB free**; Docker's WSL data is 22 GB on C:; E: 114.4 GB free | **BLOCKER risk** |
| PostgreSQL 18 | portable 18.6 at `%LOCALAPPDATA%\Programs\pgsql18\pgsql\bin` | OK for host development runs |
| CI | Windows job on Node 22.18.0 (offline tests); Ubuntu job with `postgres:18` | unchanged by this plan |

## Review Focus

1. **Identifiers with non-BMP Unicode, `|` or `:`.** The TypeScript and SQL keys must agree, and no two identities may collide. Task 2 (`key parity: astral, separators, max length`).
2. **Ambiguous amount inputs** (`"01000"`, `"10.00"`, the number `1000`). Only the canonical string form is accepted. Task 1 (`rejects non-canonical amount strings`).
3. **Eight concurrent callers for one capture.** Exactly one order. Task 10, L4 stress (`N=8`).
4. **A resolver that can't see the original backend** (a different role without `pg_read_all_stats`, or a failed probe). The result must be `STILL_UNKNOWN`, never `NOT_COMMITTED_ESTABLISHED`. Task 5 (`invisible backend stays unknown`).
5. **A capability exactly at the freshness boundary.** Inclusive at the boundary, and `STALE` one millisecond later, on an injected clock. Task 6 (`freshness boundary is inclusive`).

---

## File map

| File | Responsibility |
|---|---|
| `packages/tsconfig.json` | `{"extends":"../tsconfig.json","compilerOptions":{"erasableSyntaxOnly":true,"noEmit":true},"include":["**/*.ts"]}`, where paths are relative to `packages/` |
| `packages/guard/sql/guard-v1.sql` | **the exact migration**, used verbatim by the Checkpoint 0 smoke run and by `schema.ts` |
| `packages/guard/src/identity.ts` | contract constants, key encoding, fingerprints, event and evidence IDs, validators |
| `packages/guard/src/schema.ts` | loads `guard-v1.sql`; `migrateGuard` |
| `packages/guard/src/config.ts` | registered-statement types; `validateConfig` |
| `packages/guard/src/capability.ts` | capability types, HMAC, the shared `issueCapability` |
| `packages/guard/src/commit.ts` | `runGuardTx`, `resolveCall`, `recoverPending`, error classes |
| `packages/guard/src/guard.ts` | `createGuard`, `createOrderOnce`, `resolve`, `recoverPending` |
| `packages/guard/src/index.ts` | the production entry point. Never imports `./testing/*`. |
| `packages/guard/src/testing/index.ts` | `createTestCaptureAuthority` |
| `packages/guard/fixtures/synthetic-fixture.json` | `SYNTHETIC_FIXTURE`: merchants `SYN-M-A` and `SYN-M-B`; payee `SYN-PAYEE-1`; intents `SYN-INT-1`…`3` with captures `SYN-CAP-1`…`3`; **plus** an amended observation `SYN-CAP-1` with a different amount (`observationId: "SYN-OBS-1B"`) |
| `packages/lab-merchant/src/schema.ts` | the trusted shop schema: `shop.intents`, and `shop.orders` with no unique key on `intent_id` |
| `packages/lab-merchant/src/v-a/{original,reference-fix,ordertruth.config}.ts` | the V-A handlers and the trusted configuration |
| `packages/lab-merchant/src/nc/*.ts` | negative controls NC1–NC3, NC6–NC10 and NC12 |
| `packages/lab-merchant/src/candidate-main.ts` | runs one command and prints one JSON claim line |
| `packages/verifier/src/{report,proxy,barrier,observer,rungs,manifest,controller-main}.ts` | the verifier |
| `packages/verifier/sql/roles.sql` | roles, grants, `verifier_oracle` |
| `packages/verifier/smoke/{smoke.compose.yml,smoke.mjs}` | the Checkpoint 0 disposable smoke run (plain JavaScript) |
| `packages/verifier/docker/{base,proxy}.Dockerfile`, `gate-a.compose.yml` | the images (`qualify` and `candidate` targets) and networks |
| `packages/verifier/verifier-manifest.json` | the pinned hashes of every trusted file (Task 10) |
| `tests/v3/*.test.ts` | offline unit tests |
| `tests/v3-postgres/*.integration.ts`, `vitest.v3-postgres.config.ts` | v3 database tests: a fresh database `otg_<hex>` per file, dropped in `afterAll` |
| `package.json` (scripts) | `typecheck:packages`, `test:v3-postgres`, `v3:smoke`, `v3:qualify` and `v3:verify:gate-a` |

---

## Checkpoint 0: Environment qualification (hard prerequisite; no framework work before it passes)

### Task 0: Operator commit of the spec and plan

- [ ] **Operator:**

```bash
git add docs/superpowers/specs/2026-10-30-ordertruth-obligation-integrity-design.md docs/superpowers/plans/2026-10-30-ordertruth-v3-gate-a.md
```

```bash
git commit -m "docs: v3 Gate A spec corrections and plan revision 3"
```

### Task 0.1: Operator environment remediation

- [ ] **Docker storage:** in Docker Desktop → Settings → Resources → Advanced → Disk image location, set `E:\DockerDesktop`, then Apply & restart. Docker moves the existing disk image, so nothing is deleted. Alternatively free at least 10 GB on C:.
- [ ] **Docker engine:** start Docker Desktop with the WSL2 engine. Verify that `docker info --format "{{.OSType}}"` prints `linux`.
- [ ] **pnpm:** `corepack enable`. Verify that, in the repo, `pnpm --version` prints `11.4.0`.
- [ ] **Authorization:** the owner grants execution authorization for Checkpoint 0's disposable containers and databases.

### Task 0.2: Disposable smoke run (minimal code; container only)

**Files:**
- Create only `packages/guard/sql/guard-v1.sql`, `packages/verifier/smoke/smoke.compose.yml`, `packages/verifier/smoke/smoke.mjs` and `packages/verifier/docker/base.Dockerfile` (the minimal `smoke` target).
- Modify `package.json`, adding the smoke script:
  - `"v3:smoke": "docker compose -f packages/verifier/smoke/smoke.compose.yml up --build --abort-on-container-exit --exit-code-from smoke"`
- Do not define or build a `qualify` target/service yet. Checkpoint 0 has no dependency on package TypeScript, v3 tests, or future configuration files.

**What the smoke run does:**
- **Compose:** `postgres:18`, plus a `smoke` service built from `base.Dockerfile`.
  - The independent `smoke` target is `node:22.18.0-bookworm-slim`, then `corepack enable`, then a copy of the existing root `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`, then `pnpm install --frozen-lockfile`. It copies only `guard-v1.sql` and `smoke.mjs` created in this task. No `COPY` references future files, and no TypeScript or test runner is invoked. The workspace policy file preserves dependency build approvals; no workspace package manifests or new dependencies are introduced.
  - Network: internal only. Postgres uses a tmpfs data directory, so nothing persists.
- **`smoke.mjs` asserts, in order:**
  1. `process.version === "v22.18.0"`;
  2. `pnpm --version` is `11.4.0`, and the frozen install succeeded (the image build itself);
  3. the server's `version()` matches `PostgreSQL 18.`;
  4. `guard-v1.sql` applies to a fresh database;
  5. three fixed identities give the expected `obligation_key` strings, the Task 1 vectors;
  6. **the concurrent claim:**
     - connection A runs `BEGIN` and claims key K, and doesn't commit;
     - connection B claims K;
     - `pg_stat_activity.wait_event_type = 'Lock'` is seen for B;
     - A commits;
     - B returns zero rows, and exactly one obligation row exists.
- **Output:** it writes `/out/smoke.json`, bind-mounted to `.work/v3/gate-a/checkpoint-0/`.

- [ ] **Step 1:** `pnpm v3:smoke`. Expected: exit 0, and `smoke.json` with every assertion `true`.
- [ ] **Step 2:** `docker compose -f packages/verifier/smoke/smoke.compose.yml down -v`, then `docker volume ls --filter label=com.docker.compose.project=smoke`. Expected: empty.
- [ ] **Step 3:** record `docker system df` and the image digests in `checkpoint-0/environment.md`.

**Gate:** if any assertion fails, stop. Report the exact failure. Don't proceed on host-only results.

---

## Checkpoint 1: Identity and schema (Tasks 1–3), then an independent review

**How a checkpoint is qualified:**
- After Tasks 1–3 create their files and before this checkpoint's qualification, extend `base.Dockerfile` with a `qualify` target and add a `qualify` service (profile `qualify`) to the compose file. Add `"v3:qualify": "docker compose -f packages/verifier/smoke/smoke.compose.yml --profile qualify run --rm --build qualify"` to `package.json` here, not at Checkpoint 0.
- The qualify target retains the same pinned dependency installation and copies the complete required source/config closure: `src/`, `web/`, `scripts/`, `packages/`, `tests/`, root TypeScript/Vite/Vitest configuration files, and the new `vitest.v3-postgres.config.ts`. No `.env`, `.work`, `.git` or host dependencies enter the image. It uses disposable container database configuration only, records output under `.work/v3/gate-a/checkpoint-N/qualify.log`, and connects through `V3_PG_URL` to the disposable PostgreSQL service. Define health-checked service startup and bounded cleanup for this command.
- `pnpm v3:qualify` runs a `qualify` container (Node 22.18.0), against a `postgres:18` container, with three commands:
  - `pnpm exec tsc --noEmit -p packages/tsconfig.json`
  - `pnpm exec vitest run tests/v3`
  - `pnpm exec vitest run --config vitest.v3-postgres.config.ts`
- The output goes to `.work/v3/gate-a/checkpoint-N/qualify.log`.
- Host runs (`pnpm exec vitest …` on Node 24) are for development only.

### Task 1: Identity, encoding and validation (offline)

**Files:**
- Create `packages/tsconfig.json`, `packages/guard/src/identity.ts`.
- Test `tests/v3/identity.test.ts`.
- Modify `tsconfig.json` (add `"packages"` to `include`) and `package.json` (the script `"typecheck:packages": "tsc --noEmit -p packages/tsconfig.json"`). Add `v3:qualify` and its target/service after Tasks 1–3, as specified in this checkpoint's qualification section; it is not a Task 0.2 dependency.

**Interfaces, produced:**
```ts
export const CONTRACT = { id: "OT_V3_OBLIGATION", version: "0.1.0" } as const;
export const KEY_VERSION = 1;
export type P1Key = { paypalEnv: "sandbox"; payeeMerchantId: string; captureId: string; unit: "primary" };
export function obligationKeyP1(k: P1Key, keyVersion?: number): string;
export type P1FingerprintInput = { captureId: string; paypalOrderId: string; intentId: string; currency: string; amountMinor: string; linesHash: string };
export function fingerprintP1(i: P1FingerprintInput): string;
export type EventScope = { merchantId: string; authority: "PAYPAL" | "TEST"; paypalEnv: "sandbox"; payeeMerchantId: string;
  operationKind: "CREATE_ORDER"; obligationKey: string; eventKind: string; contractVersion: string };
export function effectEventId(s: EventScope): string;
export function evidenceEventId(s: EventScope & { callId: string }): string;
export function evidenceId(a: { authority: "PAYPAL" | "TEST"; merchantId: string; captureId: string; observationHash: string }): string;
export function validateIdentifier(v: unknown): v is string;
export function validateAmountMinor(v: unknown): v is string;
```

- [ ] **Step 1: Write the failing tests.** Each test asserts behaviour, not merely that a module exists.
  - **The canonical key:** `obligationKeyP1({paypalEnv:"sandbox",payeeMerchantId:"SYN-PAYEE-1",captureId:"SYN-CAP-1",unit:"primary"})` equals `"v1|P1|7:sandbox|11:SYN-PAYEE-1|9:SYN-CAP-1|7:primary"`.
  - **Code points:** `captureId:"𝄞a"` gives `"|2:𝄞a|"`.
  - **The collision probe:** `{payee:"a|1:b",capture:"c"}` and `{payee:"a",capture:"1:b|c"}` give different keys.
  - **Tenant-scoped effect IDs:** `effectEventId` differs for `SYN-M-A` and `SYN-M-B` when every other field is equal.
  - **Per-call evidence IDs:** `evidenceEventId` differs per `callId`.
  - **Deterministic effect IDs:** `effectEventId` is the same on two calls.
  - **Amounts** (`rejects non-canonical amount strings`): `validateAmountMinor` accepts `"0"` and `"1000"`, and rejects `"01000"`, `"10.00"`, `1000`, `"-1"` and `"1".repeat(19)`.
  - **Identifiers:** `validateIdentifier` rejects `""`, 129 code points and `"a\u0000"`, and accepts 128 astral code points.
  - **Fingerprints:** `fingerprintP1` is independent of key order, and changes when `amountMinor` changes.
  - **Smoke vectors:** the three smoke vectors from Task 0.2 equal `obligationKeyP1` of the same inputs.
- [ ] **Step 2:** `pnpm exec vitest run tests/v3/identity.test.ts`. Expected: FAIL on assertions.
- [ ] **Step 3:** implement `identity.ts`.
- [ ] **Step 4:** run it again, then `pnpm typecheck:packages`. Expected: PASS, and exit 0.

### Task 2: Schema and PostgreSQL 18 key parity

**Files:**
- Create `packages/guard/src/schema.ts` and `vitest.v3-postgres.config.ts` (`include: ["tests/v3-postgres/**/*.integration.ts"]`, `testTimeout: 30000`).
- Test `tests/v3-postgres/schema.integration.ts`.
- Modify `package.json`: add `"test:v3-postgres": "vitest run --config vitest.v3-postgres.config.ts"`.

**Interfaces, produced:**
```ts
export const GUARD_SCHEMA = "ordertruth_guard";
export function guardMigrationV1(): string;       // the contents of packages/guard/sql/guard-v1.sql
export async function migrateGuard(client: import("pg").ClientBase, merchantId: string): Promise<void>;
```

**`guard-v1.sql` contains:**
- `installation`;
- `obligations`, exactly as §5.2a for `CREATE_ORDER`, plus `claimed_by_call_id`, `origin` (`'NEW'` only), `fingerprint`, `result_table`, `result_id`, `authority`, `provenance`, `contract_version`, `sdk_version`, `path_id`, `site_id`, `build_id` and `created_at`;
- the partial unique index `obligations_p1_intent`;
- `capture_evidence`, `outbox` and `outbox_deliveries`;
- `commit_intents(call_id PK, boundary, identity jsonb, backend_pid int, backend_start timestamptz, postmaster_start timestamptz, resolved_state text NULL, resolved_at timestamptz NULL, created_at)`;
- `commit_markers(call_id PK, boundary, outcome_record jsonb NOT NULL, created_at)`.

**Database harness:**
- **Connection:** from `process.env.V3_PG_URL`, which is the compose Postgres in `v3:qualify`, or the local managed cluster on the host.
- **Refused targets:** the harness refuses any host other than `127.0.0.1`, `localhost` or `postgres`, and any database name not matching `^(postgres|otg_[0-9a-f]{20})$`.
- **Disposable databases:** it creates and drops `otg_<20 hex>`.

- [ ] **Step 1: Write the failing tests:**
  - **The generated key is accepted** (`generated key expression is accepted by PG18`): `migrateGuard` succeeds, and the server reports version 18.
  - **Key parity** (`key parity: astral, separators, max length`): 200 seeded identities, where the SQL `obligation_key` must equal `obligationKeyP1`. The seed is printed on failure.
  - **A missing capture:** `capture_id` NULL gives `23514`.
  - **The partial index:** a duplicate `(merchant, intent_id, unit)` gives `23505` on `obligations_p1_intent`.
  - **One merchant per database:** after `migrateGuard(c,"SYN-M-A")`, calling `migrateGuard(c,"SYN-M-B")` throws `/installation belongs to another merchant/`.
- [ ] **Step 2:** `pnpm test:v3-postgres -- tests/v3-postgres/schema.integration.ts`. Expected: FAIL.
- [ ] **Step 3:** implement. If PostgreSQL 18 rejected the generated primary key in Task 0.2, use the spec's fallback and say so in `guard-v1.sql`.
- [ ] **Step 4:** PASS.

### Task 3: Registered-statement validation (offline)

**Files:**
- Create `packages/guard/src/config.ts`.
- Test `tests/v3/config.test.ts`.

**Interfaces, produced:**
```ts
export type RegisteredStatement = { sql: string; params: string[]; returns: string[] };
export type GuardConfig = { createOrder: RegisteredStatement; orderLocator: RegisteredStatement; intentLocator: RegisteredStatement;
  singleTenantMerchantSchema: boolean; sites: Array<{ siteId: string; pathId: string }> };
export const REQUIRED_CREATE_ORDER_RETURNS = ["id","intent_id","paypal_order_id","capture_id","amount_minor","currency"] as const;
export class ConfigError extends Error { code: "MULTIPLE_STATEMENTS"|"TRANSACTION_CONTROL"|"DATA_MODIFYING_CTE"|"RETURNS_MISSING_IDENTITY"|"MERCHANT_PARAM_MISSING"|"UNCLASSIFIABLE"; }
export function validateConfig(c: GuardConfig): void;
```

Allowed parameter names: `merchant.id`, `intent.id`, `capture.id`, `capture.paypalOrderId`, `capture.amountMinor`, `capture.currency`, `order.id`, `path.id`, `site.id`.

- [ ] **Step 1: Write the failing tests.** Each input below must give its code:

| Input | Code |
|---|---|
| a second statement after `;` | `MULTIPLE_STATEMENTS` |
| `COMMIT` | `TRANSACTION_CONTROL` |
| `WITH x AS (DELETE …) INSERT …` | `DATA_MODIFYING_CTE` |
| `returns` missing `capture_id` | `RETURNS_MISSING_IDENTITY` |
| a multi-tenant schema with no `merchant.id` parameter | `MERCHANT_PARAM_MISSING` |
| `$$` or `--` in the SQL | `UNCLASSIFIABLE` |

  The V-A configuration literal (Task 8) passes.
- [ ] **Step 2:** FAIL. **Step 3:** implement the conservative lexical check: strip single-quoted literals, match keywords case-insensitively, and treat anything it can't classify as `UNCLASSIFIABLE`. **Step 4:** PASS.

### Checkpoint 1 gate

- [ ] **Step 1:** `pnpm v3:qualify`. Expected: exit 0, and `qualify.log` shows Node `v22.18.0` and all v3 tests passing.
- [ ] **Step 2:** an **independent review** of Tasks 1–3 against §5.2a and the Global Constraints. Blockers are fixed before Checkpoint 2.
- [ ] **Step 3:** the operator commits `packages/tsconfig.json`, `packages/guard/{sql,src/identity.ts,src/schema.ts,src/config.ts}`, `tests/v3`, `tests/v3-postgres`, `vitest.v3-postgres.config.ts`, `tsconfig.json`, `package.json` and the Task 0.2 files.

---

## Checkpoint 2: The transaction engine (Tasks 4a → 5 → 4b → 6), then an independent review

### Task 4a: Capability signing (offline)

**Files:**
- Create `packages/guard/src/capability.ts` (types and the MAC only), `packages/guard/fixtures/synthetic-fixture.json`.
- Test `tests/v3/capability.test.ts`.

**Interfaces, produced:**
```ts
export type CaptureCapability = { authority: "PAYPAL"|"TEST"; provenance: "PAYPAL_READBACK"|"SYNTHETIC_FIXTURE"; merchantId: string;
  paypalEnv: "sandbox"; payeeMerchantId: string; paypalOrderId: string; captureId: string; status: "COMPLETED";
  currency: string; amountMinor: string; intentId: string; verificationMethod: "READBACK"|"FIXTURE";
  observedAt: string; responseHash: string; evidenceId: string; mac: string };
export function signCapability(c: Omit<CaptureCapability,"mac">, key: Buffer): CaptureCapability;   // HMAC-SHA256 over canonical(c); authority is inside c
export function verifyMac(c: CaptureCapability, key: Buffer): boolean;                               // timingSafeEqual
```

- [ ] **Step 1: Write the failing tests:**
  - neither authority's key verifies a capability signed with the other's;
  - changing any one field (loop over all keys) makes `verifyMac` false;
  - a literal with `mac:"00…"` fails;
  - every fixture ID starts with `SYN-`, and the fixture declares `provenance:"SYNTHETIC_FIXTURE"`;
  - `SYN-OBS-1B` has the same `captureId` as `SYN-CAP-1`, with a different `amountMinor`.
- [ ] **Steps 2–4:** FAIL → implement → PASS.

### Task 5: The commit journal, markers, resolution and fault proxy

**Files:**
- Create `packages/guard/src/commit.ts`, `packages/verifier/src/proxy.ts`.
- Tests: `tests/v3/proxy-frame.test.ts` (pure byte-buffer parser tests, no sockets), `tests/v3-postgres/proxy.integration.ts` (fake server socket), `tests/v3-postgres/commit.integration.ts` and `tests/v3-postgres/commit-restart-child.ts` (a child-process entry point). Socket tests run only through `vitest.v3-postgres.config.ts`, never the ordinary offline suite.

**Interfaces, produced:**
```ts
export type GuardPools = { op: import("pg").Pool; aux: import("pg").Pool };          // aux: always a direct DB route
export type Boundary = "ISSUANCE" | "OPERATION" | "REJECTION_AUDIT";
export type EventualState = "COMMITTED" | "NOT_COMMITTED_ESTABLISHED" | "STILL_UNKNOWN";
export type OutcomeRecord = { [k: string]: unknown };                                    // JSON, stored in commit_markers.outcome_record
export class CommitOutcomeUnknown extends Error { readonly callId: string; readonly boundary: Boundary; readonly reason: string }
export class NotCommittedEstablished extends Error { readonly callId: string; readonly boundary: Boundary }
export class CommitEvidenceInconsistent extends Error { readonly callId: string; readonly detail: string }
export async function runGuardTx<T>(pools: GuardPools, boundary: Boundary, identity: OutcomeRecord,
  fn: (tx: import("pg").PoolClient, ctx: { callId: string }) => Promise<{ value: T; outcomeRecord: OutcomeRecord }>,
  hooks?: { beforeCommit?: () => Promise<void> }): Promise<{ value: T; callId: string; resolved?: true }>;
export async function resolveCall(pools: GuardPools, callId: string,
  o: { deadlineMs: number; confirm?: (r: OutcomeRecord, aux: import("pg").PoolClient) => Promise<boolean>;
       hooks?: { afterFirstMarkerRead?: () => Promise<void>; xactStatusOverride?: () => Promise<string | null> } }):
  Promise<{ state: EventualState; outcomeRecord?: OutcomeRecord; reason?: string }>;
export async function recoverPending(pools: GuardPools, o: { olderThanMs: number; deadlineMs: number;
  confirm?: (r: OutcomeRecord, aux: import("pg").PoolClient) => Promise<boolean> }):
  Promise<Array<{ callId: string; boundary: Boundary; state: EventualState; outcomeRecord?: OutcomeRecord }>>;
// proxy.ts
export type ProxyRule = { boundary: Boundary; mode: "drop-commit-ack" | "drop-before-commit" | "hold-commit" };
export function startFaultProxy(o: { listenPort: number; target: { host: string; port: number }; controlPort: number }):
  Promise<{ close(): Promise<void> }>;
// control API (127.0.0.1 or the trusted network only): POST /arm {ProxyRule} (applies once, to the next COMMIT on a connection whose
// latest simple query set application_name 'ot:<boundary>'); POST /release; GET /events -> [{ at, connection, boundary, action }]
```

**`runGuardTx`, in order (§5.3e):**
1. Generate `callId`.
2. Send `BEGIN`, then `SET LOCAL application_name='ot:<boundary>'`, as simple queries.
3. Set `lock_timeout` and `statement_timeout`.
4. Read `pg_backend_pid()`, `backend_start` and `pg_postmaster_start_time()`, and assert `pg_is_in_recovery() = false`.
5. **Journal the intent:** on the **aux** pool, `INSERT` the commit intent, autocommitted. If that fails, `ROLLBACK` and throw a retryable error.
6. Run `fn`.
7. `INSERT` the marker, with `outcomeRecord`.
8. Read `pg_current_xact_id()::text`.
9. `COMMIT`, as a simple query.

**On a failure in the commit phase:**
1. `release(true)`;
2. `resolveCall` with the `confirm` callback;
3. the result:
   - `COMMITTED` gives `{ value, callId, resolved: true }`, where the in-memory `value` is used only when `confirm` passed;
   - `NOT_COMMITTED_ESTABLISHED` throws `NotCommittedEstablished`;
   - `STILL_UNKNOWN` throws `CommitOutcomeUnknown`.

**`resolveCall`, matching §5.3e with a positive-evidence fast path:**
1. load the intent **from the database**;
2. check that the server isn't a standby and has the same postmaster start;
3. Read the committed marker. If present, run the mandatory boundary/outcome-specific durable confirmation below, compare the diagnostic, and return `COMMITTED` with the recorded outcome when consistent. **Do not wait for the original backend to close.** Missing required confirmation or inconsistent evidence gives `STILL_UNKNOWN`.
4. Only if the marker is absent, run `afterFirstMarkerRead` (verifier mode only).
5. Prove monitoring visibility with the operation-role probe, then establish that the original `(pid, backend_start)` has ended within the deadline. Inadequate visibility, uncertain server identity, timeout or connection failure gives `STILL_UNKNOWN`.
6. **After** establishing termination, read the marker again with a new READ COMMITTED statement on the authoritative primary, without an old transaction snapshot. Revalidate primary/server identity; a change gives `STILL_UNKNOWN`.
7. If now present, apply the same durable confirmation and diagnostic checks as step 3. If absent with all safeguards intact and no pruning, return `NOT_COMMITTED_ESTABLISHED`; a contradictory diagnostic keeps it unknown.
8. Record a definitive resolution on the intent. `STILL_UNKNOWN` remains eligible for later recovery. The pre-operation intent alone never certifies the operation's outcome.

**Mandatory confirmation dispatch (also used after a complete application restart):**

| Boundary / recorded outcome | Durable confirmation |
|---|---|
| `OPERATION / CREATED` | This call's marker, obligation with `claimed_by_call_id = callId`, matching merchant row through the trusted locator, and this call's `claimed` evidence agree. |
| `OPERATION / REUSED` | This call's marker and `reused` evidence reference an earlier valid obligation and matching result. Record `originalClaimCallId`; do **not** require the earlier claim to belong to the reuse call. No new effect is attributed to this call. |
| `OPERATION / IDENTITY_CONFLICT` | This call's marker and conflict evidence preserve both observations. No claim or merchant effect was created by this call; any earlier valid obligation is retained. |
| `OPERATION / REJECTED` | This call's marker and rejection evidence agree; its attempted claim/effect were rolled back. Do not require a new obligation or merchant result. |
| `REJECTION_AUDIT / REJECTED` | The audit marker and rejection evidence agree; the audit created no obligation or merchant effect. |
| `ISSUANCE` | Marker references the matching committed capture evidence, observation event and delivery record; capability reconstruction uses those durable fields and the separately held key. |

Each record binds call, boundary, merchant, identity, outcome and relevant evidence/result references. Unsupported outcomes, absent records or inconsistencies give `STILL_UNKNOWN`, never a fabricated result. Negative-effect checks use per-call evidence/record references and independent before/after assertions in tests, not absence of unrelated merchant history. Consumer acknowledgement remains deferred. Generic `confirm?` is an injection interface only: wrappers must supply the relevant mandatory confirmer and cannot default missing confirmation to success.

The hooks exist only when `process.env.ORDERTRUTH_GUARD_MODE === "verifier"`.

- [ ] **Step 1: Offline frame-parser tests:** feed complete, fragmented and coalesced PostgreSQL frames as byte buffers, including `CommandComplete('COMMIT')`, boundary tags and malformed lengths. Assert framing/classification only; no sockets, listeners or network calls.
- [ ] **Step 2: Socket proxy tests** (`tests/v3-postgres/proxy.integration.ts`, explicit integration suite):
  - an armed `drop-commit-ack` for `OPERATION` lets an `ISSUANCE` `COMMIT` through untouched;
  - on the next `OPERATION` `COMMIT`, it forwards the message, swallows `CommandComplete('COMMIT')` and closes the client, and the fake server logs that `COMMIT` arrived;
  - `drop-before-commit`: the server never receives `COMMIT`;
  - `hold-commit` holds until `/release`;
  - every action appears in `/events`.
- [ ] **Step 3: Commit integration tests.** The operation pool goes through the proxy; the auxiliary pool connects directly.
  - **Positive evidence while backend alive** (`committed marker resolves without backend termination`): commit normally, keep the original pooled backend alive and idle, and resolve through a fresh client. Assert `COMMITTED` with matching durable outcome before any backend shutdown.
  - **Committed** (`lost ack after server commit resolves COMMITTED from durable marker`): `drop-commit-ack` gives `resolved: true`, the marker `outcome_record` is present, and `confirm` is true.
  - **Not committed** (`commit never reached server resolves NOT_COMMITTED_ESTABLISHED after fresh read`): `drop-before-commit` throws `NotCommittedEstablished`, with no marker.
  - **The race regression** (`marker absent, then commit-and-exit, then backend gone, resolves COMMITTED`):
    1. `hold-commit`;
    2. `resolveCall` with `afterFirstMarkerRead` set to `POST /release`, then wait until the original connection closes;
    3. assert `state === "COMMITTED"`.

    This test fails against an implementation that skips the fresh re-read.
  - **The backend is alive** (`backend alive stays STILL_UNKNOWN`): `hold-commit` with a 300 ms deadline gives `STILL_UNKNOWN`. After `/release`, a second `resolveCall` resolves.
  - **The backend is invisible** (`invisible backend stays unknown`):
    - the aux pool runs under a role that is neither the operation role nor a member of `pg_read_all_stats`, which makes the probe fail;
    - the result is `STILL_UNKNOWN` with `reason` matching `/visibility/`;
    - the test **first asserts** that this role really can't see the operation role's `backend_start`, so it tests the actual permission behaviour.
  - **The diagnostic disagrees** (`contradictory xact status raises inconsistent`): `xactStatusOverride` returning `"aborted"` while the marker is present raises `CommitEvidenceInconsistent`, with `STILL_UNKNOWN`.
  - **The database is unreachable** (`db unreachable stays unknown`): with the aux pool on a closed port, `CommitOutcomeUnknown`.
  - **A restart** (`resolution after process restart uses only durable records`):
    1. spawn `commit-restart-child.ts`, which runs one `runGuardTx` with `drop-commit-ack` armed, and calls `process.exit(0)` from the commit-failure path **before** resolving;
    2. in the parent, `recoverPending({olderThanMs:0})` returns the child's `callId` with `COMMITTED` and its `outcomeRecord`;
    3. repeat with `drop-before-commit`, which gives `NOT_COMMITTED_ESTABLISHED`.
- [ ] **Steps 4–6:** FAIL → implement → PASS, running pure parser tests in the offline suite and all socket/commit tests only in the explicit integration suite.

### Task 4b: Shared issuance

**Files:**
- Modify `packages/guard/src/capability.ts` (adding `issueCapability`).
- Create `packages/guard/src/testing/index.ts`.
- Test `tests/v3-postgres/issuance.integration.ts`.

**Interfaces, produced:**
```ts
export type Observation = Omit<CaptureCapability,"mac"|"evidenceId"> & { observationHash: string };
export async function issueCapability(pools: GuardPools, o: Observation, key: Buffer): Promise<CaptureCapability>;
// testing entry
export type SyntheticFixture = { provenance: "SYNTHETIC_FIXTURE"; merchants: string[]; observations: Array<Observation & { observationId: string }> };
export function createTestCaptureAuthority(a: { pools: GuardPools; merchantId: string; fixture: SyntheticFixture; key: Buffer }):
  { issue(observationId: string): Promise<CaptureCapability> };
```

The key is passed in. In the verifier, the controller creates one key per run and passes it through the environment variable `OT_TEST_AUTHORITY_KEY`. It is redacted from every log.

`issueCapability` uses `runGuardTx(…, "ISSUANCE", …)` to write, in one transaction:
- `capture_evidence`, with `ON CONFLICT (evidence_id) DO NOTHING`;
- `capture.observed`;
- its `cloud_evidence` delivery row;
- the marker, whose `outcome_record` is `{evidenceId}`.

It returns the capability only after that `COMMIT` is acknowledged or resolved `COMMITTED`.

- [ ] **Step 1: Write the failing tests:**
  - **One issuance:** one evidence row, one event and one delivery row.
  - **Repeated issuance:** the same observation twice gives one evidence row and equal `evidenceId`s.
  - **Fails closed** (`issuance fails closed`): when `INSERT` on `capture_evidence` is revoked for the test role, `issue` rejects and returns no capability.
  - **Lost acknowledgement at issuance:** with an `ISSUANCE` `drop-commit-ack` armed, the call resolves `COMMITTED`, and the returned capability verifies.
- [ ] **Steps 2–4:** FAIL → implement → PASS.

### Task 6: `createGuard`, `createOrderOnce`, `resolve` and `recoverPending`

**Files:**
- Create `packages/guard/src/guard.ts`, `packages/guard/src/index.ts`.
- Tests: `tests/v3-postgres/guard.integration.ts` and `tests/v3/entrypoint.test.ts`.

**Interfaces, produced:**
```ts
export type GuardOptions = { pool: import("pg").Pool; auxConnectionString: string; auxMax: number; merchantId: string; buildId: string;
  paypalEnv: "sandbox"; capabilityKey: Buffer; config: GuardConfig; freshnessMs: number; now?: () => number;
  timeouts: { lockMs: number; statementMs: number; connectionMs: number };
  acceptTestAuthority?: boolean; testAuthorityKey?: Buffer;
  testHooks?: { afterClaim?: () => Promise<void>; beforeCommit?: () => Promise<void> } };   // honoured only when ORDERTRUTH_GUARD_MODE === "verifier"
export type RejectReason = "BAD_MAC"|"TEST_AUTHORITY"|"LIVE_ENVIRONMENT"|"BINDING_MISMATCH"|"STALE"|"NO_CAPTURE_EVIDENCE"|"EVIDENCE_MISMATCH"|"STATEMENT_POSTCONDITION";
export type CreateOrderResult = { outcome: "CREATED"|"REUSED"|"IDENTITY_CONFLICT"|"REJECTED"; tier: "T1"; callId: string;
  result?: { table: "orders"; id: string }; reason?: RejectReason; flags: Array<"LEGACY_CHECK_ABSENT">; resolved?: true };
export type Guard = {
  createOrderOnce(i: { capture: CaptureCapability; intentId: string; pathId: string; siteId: string }): Promise<CreateOrderResult>;
  resolve(callId: string): Promise<{ state: EventualState; result?: CreateOrderResult }>;     // rebuilt from outcome_record plus durable checks
  recoverPending(o: { olderThanMs: number }): Promise<Array<{ callId: string; state: EventualState; result?: CreateOrderResult }>>;
  close(): Promise<void> };
export async function createGuard(o: GuardOptions): Promise<Guard>;
```

**What `createGuard` checks.** It throws if any of these holds:
- `paypalEnv` isn't `sandbox`;
- a timeout isn't finite;
- `validateConfig` fails;
- the installation belongs to another merchant;
- `acceptTestAuthority` is set without `ORDERTRUTH_GUARD_MODE=verifier`, or with `NODE_ENV=production`;
- the resolver role is neither the operation role nor a member of `pg_read_all_stats`;
- the **startup visibility probe** fails;
- `NODE_ENV=production` and any `TEST`-authority obligation exists.

**`createOrderOnce`** follows §5.3c steps 1–9, with step 6 skipped and the flag `LEGACY_CHECK_ABSENT`.
- **The T1 effect:** execute `config.createOrder`, check that exactly one row comes back with identity equal on every field in `REQUIRED_CREATE_ORDER_RETURNS`, then re-read it through `config.orderLocator` in `tx`.
- **The `outcome_record`:** `{ callId, boundary, merchantId, identity, outcome, result, obligationKey, originalClaimCallId, evidenceEventId, reason }`, with outcome-appropriate references. No in-memory result is needed for reconstruction.
- **`resolve`'s `confirm`:** dispatches by boundary and outcome using Task 5's table. Only `CREATED` requires this call to own the original claim. `REUSED` checks the earlier claim; conflicts/rejections check committed decisions and rolled-back attempted effects. No universal new-obligation check is permitted.

- [ ] **Step 1: Write the failing tests:**
  - **Created, then reused** (`created then reused`): the second call, through the other path, returns the same `result.id`, and there is 1 order.
  - **Distinct intents** (`distinct intents both create`): 2 orders.
  - **A primary-key conflict on committed reuse** (`validly issued amended observation conflicts on committed obligation`):
    1. claim with `SYN-CAP-1`;
    2. issue `SYN-OBS-1B` validly (same capture, different amount; its evidence row matches it);
    3. claim with it;
    4. the result is `IDENTITY_CONFLICT`, the orders are unchanged, and the `conflict` event carries both fingerprints.
  - **A first-use evidence mismatch** (`first-use capability that disagrees with its evidence row is EVIDENCE_MISMATCH`): change `amountMinor` on a capability and re-sign it with the test key. Its `evidence_id` row disagrees, so the result is `REJECTED/EVIDENCE_MISMATCH` with no obligation. This is a separate case from the previous one, and neither rule is bent to fit the other.
  - **A secondary conflict** (`second capture for same intent conflicts via partial index`): `IDENTITY_CONFLICT`, with no claim for the second capture.
  - **Freshness** (`freshness boundary is inclusive`):
    - exactly at `observedAt + freshnessMs`, `CREATED`;
    - 1 millisecond later, on a new capture, `REJECTED/STALE`;
    - a stale capability for an already-claimed obligation, `REUSED`.
  - **The test authority:** a normal guard given a test capability returns `REJECTED/TEST_AUTHORITY`, and the audit evidence exists.
  - **Live environment:** a guard with `paypalEnv:"live"` throws `/sandbox only/`.
  - **Evidence substitution** (`evidence substitution rejected`): an `evidenceId` pointing at another capture's row gives `EVIDENCE_MISMATCH`.
  - **Lying `RETURNING`** (`lying RETURNING is caught by persisted re-read`): `REJECTED/STATEMENT_POSTCONDITION`, with no order.
  - **Pool exhaustion** (`pool exhaustion fails retryable without deadlock`): with an operation pool of 2 and 10 concurrent calls, every call settles within `connectionMs` plus 2 s, and there is 1 order.
  - **`resolve` after a restart** (`resolve after restart rebuilds CreateOrderResult from durable records`): a child process runs `createOrderOnce` with an `OPERATION` `drop-commit-ack` armed and exits. A **new** guard's `recoverPending` returns `COMMITTED`, with `result.id` equal to the order the observer sees.
  - **Outcome-specific restart matrix:** independently fault and restart after `CREATED`, `REUSED`, `IDENTITY_CONFLICT`, `OPERATION/REJECTED`, `REJECTION_AUDIT/REJECTED`, and `ISSUANCE`. For every case, a new process recovers only from journal, marker and matching durable state. Assert expected order/claim counts and decision evidence; reuse retains its earlier claim ID, conflict/rejection create no new effect, and issuance reconstructs the evidence reference. Missing/tampered required evidence yields `STILL_UNKNOWN`. Every case uses fresh state except intentional prior history within that case.
  - **The production entry point:** `entrypoint.test.ts` statically walks the imports from `index.ts`, and no specifier may contain `/testing/`.
- [ ] **Steps 2–4:** FAIL → implement → PASS. Then `pnpm typecheck:packages`.

### Checkpoint 2 gate

- [ ] **Step 1:** `pnpm v3:qualify`. Expected: exit 0, on Node `v22.18.0`.
- [ ] **Step 2:** an **independent review** of `commit.ts`, `capability.ts`, `guard.ts` and their tests against §5.3c, §5.3d and §5.3e. It must confirm, in particular:
  - the order of the resolution steps;
  - the fresh marker re-read;
  - that `confirm` is enforced;
  - that the restart path never uses process memory.
- [ ] **Step 3:** the operator commits.

---

## Checkpoint 3: The independent verifier (Tasks 7–10), then an independent review

### Task 7: The report schema and acceptance (offline)

**Files:**
- Create `packages/verifier/src/report.ts`.
- Test `tests/v3/report.test.ts`.

**Interfaces, produced:**
```ts
export type RungStatus = "PASS"|"FAIL"|"FLAKY"|"LIMITATION"|"NOT_APPLICABLE"|"NOT_RUN"|"INFRA_ERROR";
export type RungId = "L0"|"L1"|"L3"|"L4"|"L5"|"L7"|"L9"|"L21"|"L22"|"AUTH";
export const GATE_A_APPLICABLE: readonly RungId[] = ["L0","L1","L3","L4","L5","L7","L9","L21","L22","AUTH"];
export type NcId = "NC1"|"NC2"|"NC3"|"NC6"|"NC7"|"NC8"|"NC9"|"NC10"|"NC12";
export type Check = { name: string; kind: "independent_state" | "trusted_log" | "shared_logic"; ok: boolean; detail: string };
export type RungResult = { id: RungId; status: RungStatus; reproduced?: "forced"|"stress_only"; seed?: string; checks: Check[] };
export type NcResult = { id: NcId; intended: { rung: RungId; check: string }; observed: "REJECTED_AS_INTENDED"|"REJECTED_OTHERWISE"|"PASSED"|"INFRA_ERROR"; detail: string };
export type RunReport = { runId: string; validity: "VALID"|"INVALID"; invalidReasons: string[];
  candidates: Record<"ORIGINAL"|"REFERENCE_FIX", RungResult[]>; negativeControls: NcResult[];
  environment: { candidateNode: string; postgresVersion: string; images: Record<string,string>; controllerNode: string; manifestSha256: string; sourceCommit: string };
  limitations: string[] };
export function accept(r: RunReport): { accepted: boolean; reasons: string[] };
export function compareForced(a: RunReport, b: RunReport): { same: boolean; differences: string[] };
```

**Rules:**
- **The run is `INVALID` if any of these holds:**
  - an NC was observed as anything other than `REJECTED_AS_INTENDED`;
  - `ORIGINAL` L4 isn't `FAIL` with `reproduced:"forced"`;
  - the manifest drifted;
  - `candidateNode` isn't `v22.18.0`;
  - `postgresVersion` doesn't match `18.`.
- **`LIMITATION`** is never allowed in Gate A.
- **A `REFERENCE_FIX` is accepted only if** the run is `VALID` and every applicable rung is `PASS`.

- [ ] **Step 1: Write the failing tests:**
  - everything `PASS`, with all NCs `REJECTED_AS_INTENDED`, gives accepted;
  - each applicable rung with each of `FAIL`, `FLAKY`, `NOT_RUN` and `INFRA_ERROR` (looped) gives not accepted, with a reason naming the rung;
  - an NC that is `REJECTED_OTHERWISE` gives `INVALID`, because rejection for an unrelated failure doesn't count;
  - an NC that is `INFRA_ERROR` gives `INVALID`;
  - `candidateNode: "v24.11.0"` gives `INVALID`;
  - `compareForced` ignores timings and seeds, and reports a differing forced status.
- [ ] **Steps 2–4:** FAIL → implement → PASS.

### Task 8: The lab merchant (V-A original, reference fix, negative controls)

**Files:**
- Create `packages/lab-merchant/src/schema.ts`, `v-a/original.ts`, `v-a/reference-fix.ts`, `v-a/ordertruth.config.ts`, `nc/{nc1-event-id-dedup,nc2-suppress,nc3-key-on-path,nc6-hardcoded-capture,nc7-oracle-probe,nc8-fake-evidence,nc9-lying-returning,nc10-dml-cte,nc12-fake-report}.ts` and `candidate-main.ts`.
- Test `tests/v3-postgres/lab.integration.ts`.

**Interfaces:**
- **Consumes:** Task 6 (`createGuard`, `Guard`, `CreateOrderResult`) and Task 4b (`createTestCaptureAuthority`).
- **Produces:**
```ts
export const SHOP_SCHEMA_SQL: string;   // shop.intents(id text PK, sku, currency, amount_minor bigint, line_items jsonb);
                                        // shop.orders(id text PK DEFAULT gen_random_uuid()::text, intent_id, paypal_order_id, capture_id,
                                        //   amount_minor bigint, currency, created_by_path, created_at timestamptz DEFAULT now())  -- NO unique(intent_id)
export type MerchantDeps = { pool: import("pg").Pool; afterCheck: () => Promise<void>; guard?: Guard; capability?: CaptureCapability };
export type HandlerInput = { intentId: string; observationId: string };
export type HandlerResult = { ok: true; orderId: string; created: boolean; guardOutcome?: CreateOrderResult["outcome"]; callId?: string } | { ok: false; error: string; code?: string };
export function handleCheckoutReturn(d: MerchantDeps, i: HandlerInput): Promise<HandlerResult>;   // same two names in original, reference-fix and every nc/*
export function handleCaptureWebhook(d: MerchantDeps, i: HandlerInput): Promise<HandlerResult>;
```

**Command:** `node packages/lab-merchant/src/candidate-main.ts '<json>'`, where the JSON contains:
- `candidate`: `ORIGINAL`, `REFERENCE_FIX` or `NC*`;
- `op`: `checkout_return` or `webhook`;
- `intentId` and `observationId`;
- optionally `barrierKey`, `claimBarrierKey`, `crashAt: "beforeCommit"` and `merchantDb: "merchant_a"|"merchant_b"`.

It prints one line, `{"claim":HandlerResult,"pid":…}`, which is a **claim** only.

**Environment:**
- `ORDERTRUTH_GUARD_MODE=verifier`;
- `OT_TEST_AUTHORITY_KEY` and `OT_CAPABILITY_KEY` (per run, never printed);
- `PGHOST_OP=faultproxy` and `PGHOST_AUX=postgres`.

**Handlers:**
- **`original.ts`:** REF-BUG-1, exactly as `src/merchant/reference-merchant.ts:26-28`: a `SELECT` by `intent_id`, then `await d.afterCheck()`, then an `INSERT`.
- **`reference-fix.ts`:** `await d.afterCheck()`, then `createOrderOnce({capture, intentId, pathId: op, siteId: op+":order-write"})`.
- **Barriers:**
  - `afterCheck` runs `pg_advisory_lock(barrierKey)` and then unlocks, on its own connection.
  - `claimBarrierKey` wires `testHooks.afterClaim` the same way.
- **Crash:** `crashAt` sets `testHooks.beforeCommit` to `process.kill(process.pid,"SIGKILL")`.

**Negative controls**, one defect each:

| Control | Defect |
|---|---|
| NC1 | a dedup table keyed by the webhook event ID only |
| NC2 | returns `ok` and never inserts |
| NC3 | a claim keyed on `pathId` |
| NC6 | always uses `SYN-CAP-1` |
| NC7 | `SELECT * FROM verifier_oracle.expected` |
| NC8 | an obligation and a `claimed` event pointing at a nonexistent order |
| NC9 | a lying-`RETURNING` configuration |
| NC10 | a data-modifying CTE in the configuration |
| NC12 | prints `"verdict":"PASS"` and tries to write `/out/report.json` |

- [ ] **Step 1: Write the host tests** (development signal):
  - **The original duplicates** (`original duplicates under barrier`): 2 orders.
  - **The reference fix holds** (`reference fix one order under barrier`): 1 order, with outcomes `{CREATED, REUSED}`.
  - **NC2:** 0 orders.
- [ ] **Steps 2–4:** FAIL → implement → PASS.

### Task 9: Barriers, observer and roles

**Files:**
- Create `packages/verifier/src/barrier.ts`, `observer.ts` and `sql/roles.sql`.
- Test `tests/v3-postgres/observer.integration.ts`.

**Interfaces, produced:**
```ts
export async function holdBarrier(observerPool: import("pg").Pool, key: number): Promise<{ waitForWaiters(n: number, timeoutMs: number): Promise<void>; release(): Promise<void> }>;
export async function waitForLockWait(observerPool: import("pg").Pool, appNameLike: string, timeoutMs: number): Promise<void>;   // pg_stat_activity.wait_event_type = 'Lock'
export type StateSnapshot = { ordersByIntent: Record<string, Array<{ id: string; captureId: string; amountMinor: string; currency: string; paypalOrderId: string }>>;
  obligations: Array<{ key: string; intentId: string; captureId: string; resultId: string | null; callId: string }>;
  markers: Array<{ callId: string; boundary: string; outcome: unknown }>; intents: Array<{ callId: string; resolvedState: string | null }>;
  outboxKinds: Record<string, number>; outboxEventIds: string[] };
export async function snapshot(observerPool: import("pg").Pool): Promise<StateSnapshot>;            // REPEATABLE READ READ ONLY, verifier-owned SQL
export function assertOneMatchingOrder(s: StateSnapshot, intentId: string, expected: { captureId: string; amountMinor: string; currency: string; paypalOrderId: string }): { ok: boolean; detail: string };
export function assertObligationsBackedByOrders(s: StateSnapshot): { ok: boolean; detail: string };
export function assertClaimCorroborated(claim: { orderId?: string; callId?: string }, s: StateSnapshot): { ok: boolean; detail: string };   // stdout claims count only if durable state matches
```

**`roles.sql`:**
- **`ot_candidate`:** `USAGE` on `shop` and `ordertruth_guard`, and `SELECT`/`INSERT`/`UPDATE` on their tables. **No** `DELETE`, `TRUNCATE`, `TRIGGER` or `CREATE`, and no `pg_read_all_stats`. The resolver uses the same role as the operations, which is the spec's allowed case.
- **`ot_observer`:** read-only on `shop` and `ordertruth_guard`, and owner of `verifier_oracle`, with `REVOKE ALL ON SCHEMA verifier_oracle FROM PUBLIC`.
- **Passwords** come from psql variables.

- [ ] **Step 1: Write the failing tests:**
  - `snapshot()` reports 2 orders after a forced duplicate;
  - `assertObligationsBackedByOrders` fails for NC8-style rows;
  - `assertClaimCorroborated` fails for a claimed `orderId` that has no row;
  - as `ot_candidate`, `SELECT` on `verifier_oracle.expected`, `DELETE` on `ordertruth_guard.obligations` and `CREATE TRIGGER` all give `42501`.
- [ ] **Steps 2–4:** FAIL → implement → PASS.

### Task 10: The containerized controller and rungs

**Files:**
- Create `packages/verifier/src/rungs.ts`, `manifest.ts`, `controller-main.ts`, `docker/proxy.Dockerfile` and `docker/gate-a.compose.yml`, and extend `docker/base.Dockerfile` with a `candidate` target.
- Create `packages/verifier/verifier-manifest.json`.
- Test `tests/v3/manifest.test.ts`.
- Modify `package.json`: add `"v3:verify:gate-a": "tsx packages/verifier/src/controller-main.ts --gate A --runs 2"`.

**Images:**
- **`base.Dockerfile` `candidate` target:** `FROM qualify`, then `USER 1000:1000`. It has the same frozen-lockfile install, with no extra packages.
- **The `proxy` image** runs `packages/verifier/src/proxy.ts` on Node 22.18.0.

**Compose:**
- **Networks:** `internal` (`internal: true`) and `oracle` (bridge).
- **`postgres`** (`postgres:18`):
  - on both networks, published as `127.0.0.1::5432` on `oracle` only;
  - command flags `-c log_min_error_statement=error -c log_connections=on`;
  - the controller reads its logs through `docker compose logs postgres`, which are trusted.
- **`faultproxy`:** on both networks; control port published as `127.0.0.1` only.
- **`candidate`:**
  - on `internal` only;
  - `read_only: true`, `tmpfs: [/tmp]`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`;
  - `pids_limit: 128`, `mem_limit: 512m`, `cpus: 1`;
  - no volumes and no Docker socket;
  - `command: ["sleep","infinity"]`.
- **`qualify`:** like `candidate`, but it runs the L0 command and exits.

**The manifest pins, before any candidate runs**, the hash (`textSha`, with CRLF normalized, following `src/ai/ask-eval/runner.ts`) of every trusted file:
- `controller-main.ts`, `rungs.ts`, `observer.ts`, `barrier.ts`, `proxy.ts`, `report.ts` and `manifest.ts`;
- `roles.sql`;
- `synthetic-fixture.json`;
- `v-a/ordertruth.config.ts`, `v-a/original.ts` and `v-a/reference-fix.ts`;
- `guard-v1.sql` and `shop/schema.ts`;
- the Dockerfiles, the compose file, `package.json` and `pnpm-lock.yaml`.

**Controller flow:**
1. Refuse to run on manifest drift.
2. Generate the per-run keys and passwords; never log them.
3. `compose build` and `up`, and record the image digests.
4. As `ot_setup`, create **template databases**: `merchant_template`, carrying the shop schema, the guard migration, the fixture intents and the roles, and a separate `merchant_b_template` for L22.
5. **Before each independent rung or subcase,** `DROP DATABASE IF EXISTS merchant_a` and `CREATE DATABASE merchant_a TEMPLATE merchant_template`, with the same for `merchant_b`. Steps *within* one rung share state on purpose.
6. Run the candidates `ORIGINAL`, `REFERENCE_FIX` and each NC, through `docker compose exec -T candidate node …`.
7. Run everything twice, then call `compareForced`.
8. Write `.work/v3/gate-a/<runId>/{report.json,snapshots/,claims/,postgres.log,proxy-events.json}`.
9. `compose down -v`.

**Rungs.** Verdicts come only from `observer.ts`, the proxy's `/events` and the PostgreSQL log. Stdout claims count only through `assertClaimCorroborated`.

| Rung | Procedure | Pass condition |
|---|---|---|
| **L0** | In the `qualify` container on Node 22.18.0: `pnpm exec tsc --noEmit -p packages/tsconfig.json`, `pnpm exec vitest run tests/v3`, then construct a guard against `merchant_a` | all exit 0; `node -v` is `v22.18.0` |
| L1 | one `checkout_return` | `assertOneMatchingOrder` |
| L3 | return then webhook (`SYN-INT-1`), and webhook then return (`SYN-INT-2`, on a fresh database) | 1 order each; the second call's `REUSED` is corroborated |
| L4 forced | **Original:** hold K1, start both, `waitForWaiters(2)`, release K1. **Reference fix:** hold K1 and K2, start both, wait for 2 waiters on K1, release K1. Then wait for 1 waiter on K2 **and** `waitForLockWait('ot:OPERATION')`, then release K2. | original: 2 orders (`FAIL`, `forced`). Reference fix: 1 order, with `{CREATED, REUSED}` corroborated. |
| L4 stress | N=8 concurrent callers, seed recorded | 1 order |
| L7 | `SYN-INT-1` and `SYN-INT-2`, each with its own capture | 2 orders, each matching its own intent and capture |
| L9 | **(a)** claim `SYN-CAP-1`, then claim with the validly issued `SYN-OBS-1B`; **(b)** on a fresh database, a second capture for `SYN-INT-1` | (a) `IDENTITY_CONFLICT`, orders unchanged, and a `conflict` event with both fingerprints; (b) `IDENTITY_CONFLICT`, with no claim for the second capture |
| L5 | `crashAt` on the first call, then a retry, on the same database | nothing from the crashed call (no obligation, order, effect event or `claimed`); issuance evidence present; its intent unresolved until `recoverPending`, which gives `NOT_COMMITTED_ESTABLISHED`; the retry gives 1 order |
| L21 | each subcase on a fresh database. **(a)** `OPERATION` `drop-commit-ack`; **(b)** `OPERATION` `drop-before-commit`; **(c)** `OPERATION` `hold-commit`, a 300 ms deadline, then release; **(d)** the proxy stopped and **postgres paused** (`docker compose pause postgres`) during resolution; **(e)** `ISSUANCE` `drop-commit-ack`; **(f)** `OPERATION` `hold-commit`, then `docker compose restart postgres` while it is held, then `recoverPending` from a new candidate process | (a) `COMMITTED` from the marker, with `confirm`, and 1 order; (b) `NOT_COMMITTED_ESTABLISHED`, and a controlled retry gives 1 order; (c) `STILL_UNKNOWN`, then resolved; (d) `STILL_UNKNOWN` (`CommitOutcomeUnknown`); (e) `COMMITTED`, and the capability verifies; (f) `STILL_UNKNOWN`, because the postmaster start changed. A restart and a failover can't be told apart, so this conservative result is the required one. Never a second order. |
| L22 | `merchant_a` and `merchant_b` with identical local order and intent IDs | all `outboxEventIds` distinct across the two; installations correct |
| AUTH | a guard without `ORDERTRUTH_GUARD_MODE` given a test capability; a `live` guard | `REJECTED/TEST_AUTHORITY`, with audit evidence present; the live guard throws |

**Negative controls: the intended oracle each must trip.** Anything else is `REJECTED_OTHERWISE`, which makes the run `INVALID`.

| Control | Intended rung and check | Required corroboration |
|---|---|---|
| NC1 | L3, `assertOneMatchingOrder` fails (2 orders) | observer snapshot |
| NC2 | L1, `assertOneMatchingOrder` fails (0 orders) | observer snapshot |
| NC3 | L3, `assertOneMatchingOrder` fails | observer snapshot |
| NC6 | L7, a second-intent order is missing or mismatched | observer snapshot |
| NC7 | L1, `trusted_log` check: the PostgreSQL log shows `permission denied for schema verifier_oracle` from `ot_candidate`, and the verdict is unchanged | PostgreSQL log, which also proves the attempt happened |
| NC8 | L1, `assertObligationsBackedByOrders` fails | observer snapshot |
| NC9 | L1, an identity mismatch in the orders found by the observer, or `STATEMENT_POSTCONDITION` with 0 orders | observer snapshot |
| NC10 | L0, guard construction fails with `ConfigError` `DATA_MODIFYING_CTE` (a claimed code), with 0 orders and 0 obligations | observer snapshot |
| NC12 | L1, the claim's `verdict` field is ignored; the controller's verdict comes from the observer; `/out` doesn't exist in the candidate | observer snapshot, and the exec exit status for the write attempt |

- [ ] **Step 1: Manifest test** (offline): `verifierManifest()` hashes the fixed list with CRLF normalized, and `drift()` names a changed file.
- [ ] **Step 2:** FAIL → implement `manifest.ts` → PASS.
- [ ] **Step 3: Smoke:** `pnpm v3:verify:gate-a -- --only L0,L1 --candidate REFERENCE_FIX`. Expected: both `PASS`, and `environment.candidateNode` is `v22.18.0`.
- [ ] **Step 4: Full run:** `pnpm v3:verify:gate-a`. Expected:
  - `validity: "VALID"`;
  - `accept(...).accepted` is `true`;
  - the `ORIGINAL` L4 is `FAIL`, `forced`;
  - every NC is `REJECTED_AS_INTENDED`;
  - `compareForced(run1, run2).same` is `true`.

### Checkpoint 3 gate

- [ ] **Step 1:** an **independent review** of the verifier's trust boundary:
  - the roles;
  - the manifest coverage;
  - the observer-only verdicts;
  - the fresh state per rung;
  - the intended-oracle NC mapping;
  - the L0 runtime.
- [ ] **Step 2:** the operator commits.

---

## Checkpoint 4: Reproduction and evidence

### Task 11: A clean reproduction with a locked install (operator-run)

- [ ] **Step 1:** in an empty folder on E:, `git clone <repository path or remote> ot-repro`, then `cd ot-repro`, `git checkout <Checkpoint 3 commit>`, `corepack enable` and `pnpm install --frozen-lockfile`. Expected: the install succeeds, and `git status` is clean afterwards, so the lockfile is unchanged.
- [ ] **Step 2:** `pnpm v3:verify:gate-a`. Expected: `accepted: true`, and `compareForced` against the original machine's report gives `same: true`. Record both report hashes in `.work/v3/gate-a/REPRODUCIBILITY.md`.

### Task 12: Gate A evidence summary

- [ ] **Step 1:** write `.work/v3/gate-a/GATE_A_RESULT.md` with the table below, the observed statuses, report hashes, image digests, the controller and candidate Node versions, and every `NOT_TESTED` item.
- [ ] **Step 2:** if any criterion isn't PASS, the verdict is **HOLD v3**, and work returns to v2 qualification (§19).

---

## Exit criteria → tests → evidence

| # | Gate A criterion (§19) | Rung or test | Expected | Evidence |
|---|---|---|---|---|
| 1 | The original V-A reliably duplicates under forced concurrency | L4 forced on `ORIGINAL`, ×2 runs | `FAIL`, `forced`, 2 orders, in both runs | `report.json` (`ORIGINAL`, L4); snapshots |
| 2 | The reference fix gives one matching order through both paths | L3; L4 forced and stress | `PASS`; `{CREATED, REUSED}` corroborated | `REFERENCE_FIX` L3/L4; snapshots |
| 3 | Two legitimate distinct intents both produce an order | L7 | 2 matching orders | L7 |
| 4 | An identity conflict is rejected and evidenced | L9 (amended observation `SYN-OBS-1B`, and a second capture), plus the Task 6 tests | `IDENTITY_CONFLICT`; orders unchanged; `conflict` event with both fingerprints | L9; `outboxKinds.conflict` |
| 5 | A crash before `COMMIT` rolls back completely | L5 | nothing persisted from the call; `recoverPending` gives `NOT_COMMITTED_ESTABLISHED`; the retry gives 1 order | L5; snapshots before and after |
| 6 | A lost `COMMIT` acknowledgement resolves safely, including after a restart | L21 (a)–(f), plus the Task 5 race and restart tests | resolved only by the marker and `confirm`, or by "ended, then a fresh read"; otherwise `STILL_UNKNOWN`; never a second order | L21; `proxy-events.json`; markers and intents |
| 7 | No collision across merchants | L22, plus the Task 1 tenant test | distinct event IDs | L22 |
| 8 | The test authority is unusable in a normal guard, and live is refused | AUTH, plus the Task 6 tests | `REJECTED/TEST_AUTHORITY` with an audit record; the live guard throws | AUTH |
| 9 | The tamper controls are rejected | NC7–NC10, NC12 | `REJECTED_AS_INTENDED` each; run `VALID` | `negativeControls`; `postgres.log` |
| 10 | A second fresh run reproduces the forced verdicts | `--runs 2` → `compareForced` | `same: true` | `forcedComparison` |
| 11 | Reproducible from a clean checkout with a locked install | Task 11 | frozen install, `accepted`, `same: true` | `REPRODUCIBILITY.md` |

**Unknown-commit boundaries in Gate A:**
- **Tested:** `ISSUANCE` and `OPERATION`.
- **Uses the same `runGuardTx`, not separately fault-injected:** `REJECTION_AUDIT`.
- **Deferred with consumers:** the consumer acknowledgement.

**What Gate A leaves `NOT_TESTED`:** P2, T2, consumers, ingest, legacy, coverage, capacity caps, AI, codemods and real PayPal readback. A Gate A pass doesn't establish any of these.
