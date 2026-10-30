# OrderTruth v3: Payment Obligation Integrity (design)

Status: **design for approval. No product code exists for anything in this document unless it is marked as existing.**
Date: 2026-10-30. Authors: Prachi (decisions), Claude (drafting). Implementation requires separate authorization.

---

## 1. Intent

A PayPal payment can be valid while the merchant's own records are wrong:
- one capture produces two orders;
- a paid order is marked paid twice, or its fulfilment is triggered twice;
- a capture produces no order at all.

PayPal's own mechanisms don't close this gap:
- `PayPal-Request-Id` only makes PayPal's own API calls idempotent.
- Webhooks are delivered at least once: PayPal retries for up to three days.
- Neither guarantees the merchant's business outcome.

OrderTruth today (v2) detects that kind of failure, preserves PayPal evidence, and repairs the merchant record under human approval, with a verified receipt. Its AI has not shown value in three preregistered evaluations (Gate 2C advisory tie, investigator regression, Ask `ask-eval-v1` NO-GO).

**v3 moves OrderTruth from detecting the failure to preventing it, and proving the prevention:**
- a small merchant-owned **SDK** makes one payment obligation produce exactly one intended local business effect;
- an **AI Migration Agent** helps merchants adopt the SDK across code shaped differently;
- an independent **Verifier** proves, by replay, which failure conditions the resulting integration survives.

Each case ends with two separate artifacts: a **Proof of Resolution** for the data repair and a **Proof of Protection** for the prevention.

One-line positioning: *OrderTruth gives a PayPal payment-to-order integration a verifiable correctness contract. AI helps migrate code to enforce it, and an independent verifier proves which failure scenarios the integration survives.*

### Responsibilities

| Part | Owns | Never does |
|---|---|---|
| SDK (OrderTruth Guard) | Atomic obligation claims, result reuse, conflict detection, durable evidence and outbox | Call OrderTruth's cloud synchronously; move money |
| Cloud (existing app plus ingest) | Reconciliation, coverage, incidents, approved recovery, assurance records | Sit in the checkout path |
| AI Migration Agent | Finding order-effect code paths, proposing migrations, flagging uncertain coverage | Edit tests, the oracle or the contract; deploy; touch payments |
| Verifier | Deciding whether a candidate integration satisfies the contract | Trust the candidate's own tests or claims |
| Humans | Approving data recovery, merging code, deploying | — |

---

## 2. Goals, non-goals, anti-goals

**Goals**
1. A TypeScript SDK on PostgreSQL that supports two merchant patterns, with each guarantee stated precisely:
   - `createOrderOnce`: create the order after capture;
   - `markPaidOnce`: a pending order that becomes paid;
   - `handleOnce`: the consumer side of the outbox.
2. PayPal verification at runtime, bound to the merchant obligation.
3. Evidence delivered asynchronously, so a cloud outage never blocks a merchant operation.
4. An honest view of integration coverage, plus an adoption lifecycle that handles orders created before the SDK.
5. An independent, hash-pinned counterexample verifier, with negative controls that must be rejected.
6. An AI Migration Agent measured against static-analysis and codemod baselines on objective, executable metrics.
7. Proof of Resolution and Proof of Protection as separate, canonical, hashed records.
8. Lab results shown read-only in the hosted judge app.

**Guarantee tiers.** These are used throughout §5, §10, §11 and §14, and every proof states each path's tier.

| Tier | What is guaranteed | Applies to |
|---|---|---|
| **T1, guaranteed** | The obligation claim, the merchant mutation **the SDK itself performs**, and the outbox and inbox rows commit or roll back together in one PostgreSQL transaction | Registered-statement operations (§5.3a) |
| **T2, conditional** | Atomic **only if** every merchant write in the callback goes through the supplied transaction-bound client. The SDK rejects the misuse it can detect (§5.4) and cannot prove there were no other writes. | Callback operations (§5.3b), and the `handleOnce` callback |
| **T3, not guaranteed** | Nothing | Writes on other connections, external API calls, shipping and email, any code outside the enforced transaction |

The formal product guarantee is T1. T2 is a supported integration surface with tested conditions and published limits. The SDK never claims to verify that arbitrary merchant code did everything correctly.

**Non-goals (v3)**
- Exactly-once *external* effects: shipping, email, third-party APIs (§5.6).
- Partial captures, split shipments, subscriptions, refunds and reversals as obligation types. These are roadmap items needing new contracts.
- Databases other than PostgreSQL, languages other than TypeScript and ORMs other than `pg`. Adapters come later.
- Arbitrary merchant repositories, or automatic pull requests and deployment.
- Changing the existing hosted judge flow's behaviour.

**Anti-goals: v3 has failed, even if it works, if:**
- any guarantee is claimed beyond what the verifier ran (for example "never duplicates", "production-safe" or "all paths protected" without established coverage);
- the AI is credited for a result that a deterministic fallback, codemod or template produced;
- model-written code runs on the public hosted server, or outside an isolated sandbox;
- a separately reproduced reference bug is presented as the cause of the hosted judge incident;
- the SDK ever silently skips enforcement to keep checkout running;
- any historical evaluation artifact, the frozen `ask-eval-v1` package or its NO-GO is changed or reinterpreted.

---

## 3. Constraints carried from v2 (unchanged)

- PayPal **Sandbox only**, and ₹0 spend. Free-tier AI with no paid fallback, and a separate approval for each live evaluation.
- No AI capability to capture, refund, approve or execute. Recovery stays human-approved, using the existing exact-plan-hash approval.
- Git is operated by the users; agents do not commit.
- No secrets in Git or in model inputs. Reuse `src/redact.ts`.
- The existing preregistration discipline applies to every AI evaluation: freeze, hash, independent holdout, no tuning after unblinding.

---

## 4. The shared integrity contract

v3 defines a **new, distinct, versioned contract**, `OT_V3_OBLIGATION`, with two **profiles**.
- A merchant integration declares exactly one profile per business effect.
- The SDK refuses to enable both `createOrderOnce` and `markPaidOnce` for the same effect.

**Relation to v2.** The v2 contract `REF_MERCHANT_ONE_CAPTURE_ONE_ORDER_V1` (`src/merchant/contract.ts`) stays unchanged and separate. The two contracts are not assumed to be equivalent.
- A **mapping table** documents how their terms correspond: v2 matches on `attempt_id` and SKU; v3 matches on intent and a line-items hash.
- **Compatibility tests** run a shared set of cases through both the v2 checker and the v3 reconciler:
  - they assert agreement on the cases defined as equivalent;
  - they assert the documented outcome on each known divergence.
- Equivalence is claimed only for the tested cases.

**Profile P1: `ONE_CAPTURE_ONE_ORDER` (create after capture).** It corresponds to the v2 contract's intent, but is defined independently:
- An eligible verified **COMPLETED** capture yields **exactly one** active local order that matches it: the same capture, PayPal order, merchant intent, currency and amount.
- Zero orders after the grace period means suspected missing. It counts as established only with authoritative merchant state (§7.4).
- Two or more orders is a violation.

**Profile P2: `ONE_ORDER_ONE_PAID_TRANSITION` (pending first).**
- A pending merchant order transitions to paid **exactly once**.
- The transition is bound to **exactly one** verified COMPLETED capture whose amount and currency match the order.
- It emits **exactly one** fulfilment-dispatch outbox event.
- A second, different capture referencing the same order is a **payment-identity conflict**.

**Within v3, the `OT_V3_OBLIGATION` file is the single source for:**
- the SDK;
- the v3 reconciler (§7.2a);
- the coverage function;
- the verifier oracle.

Each executes it in its own way, sharing its definitions and identity rules rather than one checker function. The v2 hosted checker and receipts keep their own contract.

Versioning: `contract_id` plus a semantic version. Every evidence row, receipt and proof records the contract version it was checked against.

---

## 5. The SDK: OrderTruth Guard

New package `packages/guard`, published from this repo's pnpm workspace. It depends on `pg` only.

### 5.1 Tables (merchant-owned, created by one SDK migration the merchant authorizes)

All tables live in a dedicated schema, `ordertruth_guard`. The SDK never alters merchant tables.

The name `ordertruth` is taken: the existing cloud migrator (`src/db/postgres-migrate.ts`) owns it and refuses unmanaged schemas. In the lab and in tests, the **merchant database is a separate PostgreSQL database from the cloud's**, never the same one.

| Table | Purpose | Key constraints |
|---|---|---|
| `ordertruth_guard.obligations` | One row per claimed business obligation, for both profiles | One physical PK, `(merchant_id, operation_kind, obligation_key)`. Profile-specific partial unique indexes and `CHECK` constraints (§5.2a). |
| `ordertruth_guard.capture_evidence` | The verified capture record, persisted when the capability is issued (§6) | PK `evidence_id`. Stores the verification method, observed time and response hash. |
| `ordertruth_guard.outbox` | Durable events for fulfilment and for OrderTruth evidence | PK `event_id` (§5.5). |
| `ordertruth_guard.outbox_deliveries` | One delivery row per event **per destination** | PK `(event_id, destination)`. Each row keeps its own state, attempts, lease, next attempt, ack time and last error. |
| `ordertruth_guard.inbox` | Consumer claims for `handleOnce` | PK `(consumer, event_id)`. Stores the payload fingerprint, the bound obligation key, the outcome and the result reference. |
| `ordertruth_guard.enforcement` | When enforcement started, per path and effect (§8) | PK `(path_id, effect)`. |
| `ordertruth_guard.paths` | The declared path registry (§7.1) | PK `path_id`. |

Every row stores the `contract_version`, the `sdk_version`, the `path_id` and the `build_id` (merchant-supplied deployment identifier).

### 5.2 Obligation identity

| Operation | Logical identity (encoded into the one physical key, §5.2a) | Also unique (partial index, §5.2a) | Fingerprint (checked on reuse) |
|---|---|---|---|
| `createOrderOnce` (P1) | `(merchant_id, paypal_env, payee_merchant_id, capture_id, 'CREATE_ORDER', unit)` | `(merchant_id, intent_id, 'CREATE_ORDER', unit)`, so one intent can't get two orders from two captures | hash of capture ID, PayPal order ID, intent ID, currency, amount in minor units, and a hash of the line items. The SDK reads the line items from the merchant intent through the registered **intent locator**. Callers never pass them, so both paths fingerprint identically. |
| `markPaidOnce` (P2) | `(merchant_id, merchant_order_id, 'MARK_PAID')` | `(merchant_id, paypal_env, payee_merchant_id, capture_id, 'MARK_PAID')`, so one capture can't pay two orders | hash of capture ID, PayPal order ID, merchant order ID, currency and amount |
| `handleOnce` | `(consumer, event_id)` in `ordertruth_guard.inbox` | — | canonical hash of the event payload, plus a **binding check**: `event_id` must equal the ID recomputed from the payload's obligation key and kind (§5.5) |

`unit` is a literal `"primary"` in v3. It is reserved for future split fulfilment.

The table above gives each profile's **logical** business identity. §5.2a gives the single **physical** table that stores both.

### 5.2a Physical layout of `ordertruth_guard.obligations`

One table serves both profiles. PostgreSQL allows only one primary key per table, so each logical identity is encoded into one canonical key column.

```sql
CREATE TABLE ordertruth_guard.obligations (
  merchant_id        text NOT NULL,
  operation_kind     text NOT NULL CHECK (operation_kind IN ('CREATE_ORDER','MARK_PAID')),
  paypal_env         text,
  payee_merchant_id  text,
  capture_id         text,
  intent_id          text,          -- P1
  merchant_order_id  text,          -- P2
  unit               text NOT NULL DEFAULT 'primary',
  key_version        smallint NOT NULL DEFAULT 1,
  obligation_key     text GENERATED ALWAYS AS (
    CASE operation_kind
      WHEN 'CREATE_ORDER' THEN 'v' || key_version || '|P1|' || paypal_env || '|' || payee_merchant_id || '|' || capture_id || '|' || unit
      WHEN 'MARK_PAID'    THEN 'v' || key_version || '|P2|' || merchant_order_id
    END) STORED,
  -- origin, fingerprint, fingerprint_kind (FULL | PARTIAL), result_reference, authority, provenance,
  -- contract_version, sdk_version, path_id, build_id, created_at …
  PRIMARY KEY (merchant_id, operation_kind, obligation_key),
  CHECK (operation_kind <> 'CREATE_ORDER' OR (paypal_env IS NOT NULL AND payee_merchant_id IS NOT NULL AND capture_id IS NOT NULL AND intent_id IS NOT NULL)),
  CHECK (operation_kind <> 'MARK_PAID'    OR (merchant_order_id IS NOT NULL AND paypal_env IS NOT NULL AND payee_merchant_id IS NOT NULL AND capture_id IS NOT NULL))
);
-- P1: one intent can't get orders from two captures
CREATE UNIQUE INDEX obligations_p1_intent  ON ordertruth_guard.obligations (merchant_id, intent_id, unit)
  WHERE operation_kind = 'CREATE_ORDER';
-- P2: one capture can't pay two orders
CREATE UNIQUE INDEX obligations_p2_capture ON ordertruth_guard.obligations (merchant_id, paypal_env, payee_merchant_id, capture_id)
  WHERE operation_kind = 'MARK_PAID';
```

- **If the target PostgreSQL version rejects a generated column in the primary key,** the builder may compute `obligation_key` in the SDK instead. A `CHECK` must then require it to equal the same expression. Either way the encoding is tested.
- **The key is computed by the database.** A stored generated column computes `obligation_key` from the typed columns, so the SDK can't build a mis-encoded key, and the `CHECK`s guarantee every identity part is present.
- **Changing the encoding.** The `|` separator is safe because PayPal and merchant identifiers are validated not to contain it. Any change to the encoding bumps `key_version`, which requires a migration with its own tests.
- **The claim's conflict target** is exactly `ON CONFLICT (merchant_id, operation_kind, obligation_key)`. Violations of the partial unique indexes are not covered by it, so they raise SQLSTATE 23505, which becomes `IDENTITY_CONFLICT` (§5.3c step 3).
- **The partial indexes enforce the secondary rules only among SDK obligations.** Legacy merchant rows that never went through the SDK are checked by the cardinality rules in §8.

**Outcomes** (a typed result, never an untyped exception, for the expected outcomes):
- `CREATED`: this call claimed the obligation and its effect committed.
- `REUSED`: the obligation already existed with an identical fingerprint. The original stored `result_reference` is returned, and neither the statement nor the callback runs.
- `REUSED_LEGACY` (P1): no obligation existed, but legacy reconciliation (§8) found a matching order created before enforcement. That order is adopted as a `BACKFILLED` obligation, and nothing new is created.
- `LEGACY_ALREADY_PAID` (P2): the order was already paid before enforcement, and its bound capture matches. No transition happens and no dispatch event is emitted.
- `BYPASS_DETECTED`: a matching order (P1) or paid transition (P2) was written **after** `enforced_since` by a path that didn't go through the SDK (§8). No new effect is created. The effect's coverage becomes `UNPROTECTED`.
- `handleOnce` has its own outcomes, `HANDLED`, `REUSED` and `EVENT_CONFLICT` (§5.5). The commit behaviour for every outcome is in §5.3d.
- `IDENTITY_CONFLICT`:
  - an existing obligation has the same key but a different fingerprint; or
  - a secondary unique index hit (another capture for this intent or order, or this capture already used for another order).

  Nothing is written to merchant tables. A conflict row is written to `ordertruth_guard.outbox` as evidence, keeping **both** observations. No automatic refund, void or retry follows.
- `REJECTED`: a precondition failed, such as an unverified capture, a status other than COMPLETED, an amount or currency mismatch, stale evidence, or a transaction-participation violation (§5.4). The transaction rolls back.

`source_path` is evidence metadata. It is **never** part of any key. That is the property that makes different handler paths converge on one obligation.

### 5.3 Transaction protocol

Every operation comes in one of two forms. The names are indicative; the semantics are binding.

### 5.3a Registered-statement form (tier T1, preferred)

At setup, the merchant registers fixed, parameterized statements. The SDK executes them itself inside the operation transaction, and checks the rows they return. The SDK never builds SQL from runtime input.

```ts
const guard = createGuard({ pool, merchantId, contract, buildId, capabilityKey,
  statements: {
    // P1: values come only from the intent locator and the verified capture
    createOrder: { sql: "INSERT INTO orders(intent_id, paypal_order_id, capture_id, amount_minor, currency, ...) VALUES($1,$2,$3,$4,$5,...) RETURNING id, intent_id, paypal_order_id, capture_id, amount_minor, currency",
                   params: ["intent.id", "capture.paypalOrderId", "capture.id", "capture.amountMinor", "capture.currency", /* ... */],
                   returns: ["id", "intent_id", "paypal_order_id", "capture_id", "amount_minor", "currency"] },
    // P2: the WHERE clause makes the transition conditional on 'pending'
    markPaid:    { sql: "UPDATE orders SET status='paid', paid_capture_id=$2 WHERE id=$1 AND status='pending' RETURNING id, status, paid_capture_id, amount_minor, currency",
                   params: ["order.id", "capture.id"],
                   returns: ["id", "status", "paid_capture_id", "amount_minor", "currency"] },
    // Legacy lookups return ALL candidate rows: no LIMIT (§8 cardinality)
    legacyOrdersForObligation: { sql: "SELECT id, intent_id, capture_id, amount_minor, currency, status, created_at FROM orders WHERE intent_id=$1 OR capture_id=$2", params: ["intent.id", "capture.id"] },
    legacyPaidForCapture:      { sql: "SELECT id, paid_capture_id, status, paid_at FROM orders WHERE paid_capture_id=$1", params: ["capture.id"] },
  } });
const r = await guard.createOrderOnce({ capture, intentId, pathId });
// r: { outcome: "CREATED" | "REUSED" | "REUSED_LEGACY" | "IDENTITY_CONFLICT" | "REJECTED", result?, conflict?, reason?, tier: "T1" }
```

- **Registration checks:** each statement declares the identity columns it returns (`returns`).
  - The guard refuses to start if a required identity column is missing from the declaration.
  - It also checks every returned row for those keys at runtime.
- **Row checks (the full operation identity):**
  - `createOrder` must return **exactly one** row in which `intent_id`, `paypal_order_id`, `capture_id`, `amount_minor` and `currency` **all** equal the obligation's values.
  - `markPaid` must return **exactly one** row in which `id` is the obligation's merchant order, `status` is `paid`, `paid_capture_id` equals the bound capture, and `amount_minor` and `currency` match.
  - Any missing, extra or unequal value rolls back to S1 with `REJECTED: STATEMENT_POSTCONDITION`.
- **P2 legacy case:** `markPaid` returning **zero** rows because the order is already paid is handled under §8 (`LEGACY_ALREADY_PAID`), not as success.
- **Optional `after(tx)` hook:** a T1 operation may also take one, for the merchant's extra local writes. Those writes are **T2** and are reported as such.

### 5.3b Callback form (tier T2)

```ts
const r = await guard.createOrderOnce({ capture, intentId, pathId }, async tx => {
  const id = await tx.query("INSERT INTO orders(...) VALUES(...) RETURNING id", [...]);
  return { table: "orders", id: id.rows[0].id };          // result reference
});
// r.tier === "T2"
```

- The callback form exists for code that can't express its effect as one registered statement.
- **`markPaidOnce` has no callback form.** Its transition is always the registered statement (T1). Only its `after(tx)` hook is T2.

### 5.3c Protocol (both forms)

Each operation runs in one PostgreSQL transaction (READ COMMITTED) on a client from the merchant's **operation pool**. A small **auxiliary pool** (§5.4b) is used only for the T2 independent check and for best-effort evidence.

1. **Before the operation transaction:** verify the capability's HMAC and authority (§6.1) and its **binding** to the input (amount, currency, intent or order).
   - On failure, the SDK writes `rejected` evidence in its own short **audit transaction** on the operation client, then returns `REJECTED`.
   - **If that audit commit fails, the SDK throws a retryable error instead of returning `REJECTED`.** A returned `REJECTED` therefore always has durable evidence.
   - Freshness is **not** checked here (step 4).
2. `BEGIN`. Set a bounded `lock_timeout` and `statement_timeout` (configurable and always finite; defaults are left to the builder).
3. Take savepoint **S1**, then `INSERT INTO ordertruth_guard.obligations … ON CONFLICT (merchant_id, operation_kind, obligation_key) DO NOTHING RETURNING *` (§5.2a).
   - **The conflict target is exactly the physical primary key.** A bare `ON CONFLICT DO NOTHING` would also swallow the partial-unique-index violations, which must surface as `IDENTITY_CONFLICT`.
   - Under READ COMMITTED, the follow-up `SELECT` of the existing row is a new statement with a new snapshot, so it sees the row that the conflicting transaction committed.
   - **Waiting:** if another transaction holds the same key uncommitted, this insert waits until that transaction commits or rolls back.
     - So when it returns no row, the existing obligation is **committed**.
     - `REUSED` therefore never refers to an obligation that might still roll back.
   - **No row (the primary key exists):** `SELECT` the existing obligation.
     - If the fingerprint is equal, or a `BACKFILLED` partial fingerprint matches on its fields: write a `reused` evidence event, `COMMIT`, and return **`REUSED`** with the stored result.
       - No freshness check applies: a retry with an expired capability still gets `REUSED`.
     - If it differs: write a `conflict` evidence event carrying both fingerprints, `COMMIT`, and return **`IDENTITY_CONFLICT`**. No claim is added.
   - **Secondary unique violation** (SQLSTATE 23505 from a secondary index):
     - `ROLLBACK TO S1`, which removes this call's claim;
     - write the `conflict` evidence;
     - `COMMIT`;
     - return **`IDENTITY_CONFLICT`**.
   - **Row returned (claimed):** continue.
   - **From here on, a decision that must not keep the claim** does `ROLLBACK TO S1`, writes its evidence in the same transaction, and commits. This works even after an SQL error, because rolling back to a savepoint clears an aborted transaction.
4. **Freshness (the claim path only).** If the capability is stale: `ROLLBACK TO S1`, write evidence, `COMMIT`, and return `REJECTED: STALE`.
5. **Link the obligation to its `capture_evidence` row.** That row was committed when the capability was issued (§6). If it's missing: roll back to S1 and return `REJECTED: NO_CAPTURE_EVIDENCE`.
6. **Pre-effect checks** (§8):
   - **P1:** run `legacyOrdersForObligation`, which returns every candidate row (§8).
   - **P2:** run `SELECT … FOR UPDATE` on the order through the registered order locator, run `legacyPaidForCapture` (all orders bound to this capture), and classify the order's state.
   - Each result maps to one row of the outcome table (§5.3d).
7. **The effect** (only when step 6 says to create):
   - **T1:** execute the registered statement and check its returned rows.
   - **T2:** run the callback with the restricted client, then run the participation check (§5.4).
   - A callback that throws, a failed postcondition or a failed participation check: roll back to S1, write evidence, `COMMIT`, then return `REJECTED`. A callback's error is rethrown.
8. **On success:**
   - set the obligation's `result_reference`;
   - insert the effect outbox events and their per-destination delivery rows (§5.5);
   - insert the `claimed` evidence event.
9. `COMMIT`.

### 5.3d Outcome table

| Outcome | Claim row | `origin` | Fingerprint stored | Merchant effect | Outbox events written | Evidence |
|---|---|---|---|---|---|---|
| `CREATED` | commits | `NEW` | full | yes | effect events (P2 `fulfilment.dispatch`; P1 `order.created` if enabled) and `claimed` | in the transaction |
| `REUSED` | the existing row | — | — | none | `reused` | in the transaction |
| `REUSED_LEGACY` (P1) | commits | `BACKFILLED` | partial, from the legacy row | none new | `reused_legacy` only (no `order.created`) | in the transaction |
| `LEGACY_ALREADY_PAID` (P2) | commits | `BACKFILLED` | partial | none | `legacy_already_paid` only (**no dispatch**) | in the transaction |
| `IDENTITY_CONFLICT`, primary key with a different fingerprint | none added | — | — | none | `conflict` with both fingerprints | in the transaction |
| `IDENTITY_CONFLICT`, a secondary index or a legacy mismatch | rolled back to S1 | — | — | none | `conflict` | in the transaction |
| `BYPASS_DETECTED` (§8) | rolled back to S1 | — | — | none | `bypass`, which makes the effect's coverage `UNPROTECTED` | in the transaction |
| `REUSED_LEGACY` or `LEGACY_ALREADY_PAID` flagged `LEGACY_UNDATED` | commits | `BACKFILLED`, provenance `UNCERTAIN` | partial | none | the outcome's event, flagged uncertain, which blocks coverage claims | in the transaction |
| `REJECTED: LEGACY_AMBIGUOUS` | rolled back to S1 | — | — | none | `rejected` and `duplicate.detected` | in the transaction |
| `REJECTED` decided before the transaction (HMAC, authority, binding) | none | — | — | none | `rejected`, in its own audit transaction. If the audit fails, the SDK throws instead. | audit transaction |
| `REJECTED` (stale, no capture evidence, postcondition, participation, callback threw, legacy unverifiable, order state) | rolled back to S1 | — | — | rolled back | `rejected` | in the transaction |
| The transaction is unusable (connection lost, a server-side abort that a savepoint can't clear) | rolled back by PostgreSQL | — | — | rolled back | — | best effort after the rollback (§5.4a) |
| The process is killed | rolled back by PostgreSQL | — | — | rolled back | — | none. A retry decides afresh. |

A rolled-back claim never occupies a primary or secondary slot. That is why a mismatched replay can't block the legitimate capture that comes later.

**Failure semantics**

| Failure | Result |
|---|---|
| Crash or kill before `COMMIT` | Nothing from this operation persists. The `capture_evidence` row and `capture.observed` event committed when the capability was issued (§6) remain. A retry claims afresh. |
| Crash after `COMMIT`, before the caller receives the reply | A retry returns `REUSED` with the same result, even if the capability has since gone stale. Neither the statement nor the callback runs again. |
| Callback throws | Roll back to S1. `rejected` evidence commits. The error is rethrown. The obligation is unclaimed. |
| Database unavailable | The operation fails. The SDK **never** bypasses enforcement (`REJECTED` or a throw). Retrying is the merchant's controlled decision. |
| Lock or pool timeout | The operation fails with a retryable error, and nothing from this operation persists. |

### 5.4 Transaction participation: what T2 can and can't check

T1 doesn't need a participation check, because the SDK performs the write itself on `tx`. For T2 callbacks, the SDK checks only what PostgreSQL's MVCC semantics make sound:

1. **The client is restricted.** The callback receives a wrapped client that exposes only `query`. It doesn't expose `release` or `connect`, and it rejects `BEGIN`, `COMMIT`, `ROLLBACK` and `SAVEPOINT` text.
2. **The inserted result row must be inside `tx`.** This applies to P1 callbacks, whose result is a newly **inserted** row:
   - It must be visible inside `tx`, located through a registered locator query.
   - It must be **invisible** from an auxiliary-pool connection before `COMMIT`.
   - Under MVCC an uncommitted insert is invisible to other sessions, so a result row visible from outside was committed outside `tx`. The call is then `REJECTED: TX_PARTICIPATION`.
   - This is sound **only for inserts.** An uncommitted *update* leaves the old row version visible to other sessions, so the check isn't used for updates. That's why P2's transition is always a T1 registered statement.
3. **What T2 can't check:** additional writes the callback makes on another connection, external calls, or anything else outside `tx`. These aren't detected.
   - Every T2 proof carries the limitation **"callback side-writes outside the transaction are not detectable"**.
   - Ladder rung L13 demonstrates this limitation; it doesn't pretend to solve it.

The independent-connection check doesn't prove participation. It catches one specific misuse: the result row committed elsewhere.

Unsupported T2 patterns are documented and, where detectable, rejected:
- nested transactions;
- external connections;
- network calls made before the write.

Where a pattern can't be detected, the documentation says so and the ladder records it as a limitation (L13).

### 5.4a Evidence durability

- **Durable for every decided outcome.** Every outcome the SDK decides commits its evidence before the outcome is returned:
  - inside the operation transaction, after `ROLLBACK TO S1` where needed (§5.3d);
  - or, for rejections decided before that transaction (§5.3c step 1), in a separate audit transaction. If that audit fails, the SDK throws instead of returning `REJECTED`.

  The ladder asserts this deterministically (L9, L14).
- **Best effort only when the transaction is unusable.** If the transaction can't be used (lost connection, or a server-side abort that a savepoint can't clear), the SDK tries one evidence write on an **auxiliary-pool** connection.
  - If that write fails, it increments an in-process counter, which the heartbeat reports (§7.2a).
  - **No rung asserts best-effort evidence.**

### 5.4b Connection pools (no circular wait)

- **Two pools:** the merchant's **operation pool**, and a dedicated, small **auxiliary pool** created by the guard.
- **Acquisition order:**
  - An operation first acquires its operation client.
  - Only then, and only for the T2 check or the best-effort write, does it acquire an auxiliary client briefly.
  - Auxiliary clients never wait on operation clients, so there is no circular wait.
- **Both pools have finite connection timeouts.** `pg`'s default is infinite, so the guard refuses to start without one.
  - A pool timeout fails the operation with a retryable error, and nothing from it persists.
- **L17** exercises concurrency above both pool sizes.

### 5.5 Outbox, delivery and `handleOnce`

- **Outbox event IDs:**
  - **Effect events** (`fulfilment.dispatch`, `order.created`): `sha256(obligation_key ‖ event_kind ‖ contract_version)`, so re-emission is deduplicated downstream.
  - **Evidence events** (`claimed`, `reused`, `reused_legacy`, `legacy_already_paid`, `conflict`, `bypass`, `rejected`): `sha256(obligation_key ‖ event_kind ‖ call_id)`. A conflict event also carries both fingerprints.
  - **`REUSED` emits an evidence event.** The path that loses the race, usually the webhook, still proves it is enforced, which coverage needs.
- **Destinations:**
  - Each event kind maps to a fixed set of destinations: `cloud_evidence` for every event, and `consumer:<name>` for effect events with a registered consumer.
  - One `outbox_deliveries` row per destination is inserted in the **same** transaction as the event.
- **Delivery states:**

| State | Meaning | Terminal |
|---|---|---|
| `PENDING` | due for delivery | no |
| `LEASED` | taken by a shipper or consumer; the lease has an expiry | no |
| `DELIVERED` | acknowledged by that destination | yes |
| `RETRY` | the last attempt failed; it is retried with backoff, and the attempt count goes up | no |
| `POISONED` | a consumer delivery that failed the configured maximum number of attempts; evidence is recorded and a human must review it | yes |
| `CONFLICT` | a consumer delivery rejected with `EVENT_CONFLICT`; dead-lettered with evidence, and never retried automatically | yes |

`cloud_evidence` deliveries never poison. They retry indefinitely with backoff, and the heartbeat reports how old the backlog is. An expired lease returns to `PENDING`, which is the recovery path after a crash.

- **Shipper (destination `cloud_evidence`):** `startOutboxShipper()` leases due rows with `FOR UPDATE SKIP LOCKED`, posts them to the cloud ingest (§7.2), and marks **only** the `cloud_evidence` row delivered after the cloud acknowledges.
  - It never touches consumer delivery rows.
  - Delivery is at-least-once, and ingest is idempotent by `event_id`.
- **Consumer transport in v3:** the consumer **shares the merchant database**, and pulls its own deliveries.
  - `guard.consume(name, fn)` runs `handleOnce` for each due `consumer:<name>` delivery.
  - The **acknowledgement is atomic with the effect**: the delivery row is marked `DELIVERED` in the same transaction as the inbox claim and `fn`'s writes.
  - Consumers in a different database, or behind HTTP or a queue, are out of scope for v3. That is roadmap work, with an inbox in the consumer's own database.
- **`handleOnce(consumer, delivery, fn)`** opens its own transaction on the operation pool:
  1. Lease the delivery row: `SELECT … FOR UPDATE SKIP LOCKED`.
  2. **Binding check:** recompute the effect event ID from the payload's obligation key and kind.
     - If it doesn't match: write `conflict` evidence, mark the delivery `CONFLICT`, `COMMIT`, and return **`EVENT_CONFLICT`**.
     - `fn` is not run.
  3. Take savepoint **S1**, then `INSERT … ON CONFLICT (consumer, event_id) DO NOTHING RETURNING *`. The row stores the payload fingerprint and the bound obligation key.
  4. **Claimed:** run `fn(tx)` (T2).
     - On success: store the result reference, mark the delivery `DELIVERED`, `COMMIT`, and return **`HANDLED`**.
     - If `fn` throws: `ROLLBACK TO S1`, which removes the inbox claim. Mark the delivery `RETRY`, or `POISONED` at the attempt limit. Write evidence, `COMMIT`, and rethrow.
  5. **Not claimed:** compare the stored fingerprint and binding with this payload.
     - If they're equal: mark the delivery `DELIVERED`, `COMMIT`, and return **`REUSED`** with the stored result. `fn` is **not** run.
     - If they differ: write `conflict` evidence with both fingerprints, mark the delivery `CONFLICT`, `COMMIT`, and return **`EVENT_CONFLICT`**. `fn` is **not** run, and nothing retries automatically.

  The consumer's **local** effect happens once per `(consumer, event_id)` for an unchanged payload, and a changed payload is never treated as a duplicate.

### 5.6 External effects: the explicit limit

`handleOnce` makes the consumer's local database effect happen once. It **cannot** make an external call (a shipping API, email, a payment) exactly-once.

The SDK documentation and every Proof of Protection state this limit. The recommended pattern:
- The consumer records the intent locally under `handleOnce`.
- It then calls the external system with an idempotency key derived from `event_id`, where that system supports one.
- It reconciles later.

The verifier contains a rung (L11) that **records** duplicate external calls as a limitation, never as a pass.

---

## 6. PayPal verification boundary

**Existing pieces reused:**
- `src/webhooks/verifier.ts`: postback verification via `POST /v1/notifications/verify-webhook-signature`, Sandbox host only.
- `src/paypal/client.ts`: Orders v2 `GET` readback and `PayPal-Request-Id`.
- `src/webhooks/postgres-inbox.ts`: deduplication of verified webhook events.

**The SDK's `CaptureVerifier`** runs in the **merchant's** backend, never in OrderTruth's cloud. It produces a `VerifiedCapture` only after one of two methods:
- **Readback (required for fulfilment):** an authoritative `GET` of the PayPal order or capture with the merchant's credentials, showing the capture as `COMPLETED`.
- **Webhook then readback:** a signature-verified `PAYMENT.CAPTURE.COMPLETED` webhook, followed by a readback. The webhook alone proves the notification is authentic, not the current payment state, so on its own it is evidence, not grounds to fulfil. `PENDING` and `DENIED` never produce a fulfilment-grade capability.

A `VerifiedCapture` binds:
- the PayPal environment and payee merchant ID;
- the PayPal order ID and capture ID;
- the status, currency and amount;
- the merchant intent or order binding, from `custom_id`/`invoice_id` or the merchant's own mapping;
- the verification method and the PayPal debug ID;
- the observation time;
- the response hash and the evidence ID.

**Trust is enforced at runtime, not by the type:**
- The object carries an HMAC over its fields, keyed by a merchant-local `capabilityKey`. `guard.*Once` recomputes it, so a hand-written object literal or a type assertion fails.
- **Scope:** `capabilityKey` is shared across the merchant's own processes. A capability is serializable, so a queue worker can carry one from the web process (variant V-C), and a restarted process can reuse one (L5, L6). A consumer that receives a capability outside the freshness window must re-verify.
- **Freshness:** `observed_at` must fall within a configurable window before the operation.
- **Capture facts, failing closed:** before `CaptureVerifier` returns a capability, it commits one short transaction containing:
  - the `capture_evidence` row;
  - a `capture.observed` outbox event;
  - that event's `cloud_evidence` delivery row.

  **If that commit fails, no capability is issued.** Verification returns an error and the merchant retries. Every capability in existence therefore has durable capture evidence behind it, and the cloud learns about every verified capture, including ones that never produce an effect (L8).
  - A capability whose `evidence_id` has no committed `capture_evidence` row is rejected at step 4 of §5.3c.
  - A missing `capture.observed` event in the cloud means "not yet delivered" (see the per-destination backlog). It never means "no capture was verified".
- Binding: the amount, currency and intent or order must equal the obligation input. Otherwise the result is `REJECTED` (if the input is wrong) or `IDENTITY_CONFLICT` (if a different payment is already bound).

The HMAC protects against developer mistakes and in-process forgery, **not** against a compromised merchant server. Third-party auditability comes from the persisted `capture_evidence` row, which includes the PayPal debug ID and the response hash.

### 6.1 Two evidence authorities, strictly separated

| | **PayPal authority** (production) | **Test authority** (lab and verifier only) |
|---|---|---|
| Issued by | `CaptureVerifier`: readback, or webhook then readback, against PayPal | `TestCaptureAuthority` in a separate entry point, `@ordertruth/guard/testing` |
| Capability | `VerifiedCapture`, with `authority: "PAYPAL"` | `TestVerifiedCapture`, with `authority: "TEST"` and `provenance: "SYNTHETIC_FIXTURE"` |
| HMAC key | the merchant's `capabilityKey` | a separate key generated per test run. The HMAC input includes the authority name, so neither authority's key validates the other's capabilities. |
| Accepted by | every guard | only a guard created with `acceptTestAuthority: true` |

**Runtime enforcement**, in addition to the types:
1. **Creating a guard with `acceptTestAuthority: true` throws unless all of these hold:**
   - `ORDERTRUTH_GUARD_MODE=verifier` is set;
   - `NODE_ENV` is not `production`;
   - the configured PayPal environment is not live.
2. **A guard without that flag rejects** any capability whose authority isn't `PAYPAL`, with `REJECTED: TEST_AUTHORITY`, before `BEGIN`.
3. **Every row records its authority:** each obligation, evidence and outbox row stores `authority` and `provenance`.
   - A guard running in production mode refuses to start if its database contains any `TEST`-authority obligations.
   - A merchant database used for testing can therefore never become production quietly.
4. **One issuance code path.** `CaptureVerifier` and `TestCaptureAuthority` both issue capabilities through one shared internal function.
   - That function commits the `capture_evidence` row, the `capture.observed` event and its delivery row before it returns a capability (§6).
   - Only the evidence **source** differs: a PayPal readback, or the synthetic fixture.
   - So L15 in the lab exercises production's issuance code.
5. **The production entry point never loads the test authority.** `@ordertruth/guard` doesn't import `/testing`, and a test asserts that importing the production entry point doesn't load the test module.

### 6.2 The lab fixture (public, synthetic)

- **What it is:** a committed, invented PayPal-shaped fixture (orders, captures, payee) modelled on the shape of a real Orders v2 readback.
  - It uses obviously synthetic IDs with a recognisable prefix.
  - It is labelled `SYNTHETIC_FIXTURE` in the file, in every capability, in every evidence row and in every proof.
- **What it never claims:** that any of its data came from PayPal.
- **No real PayPal data:** no genuine Sandbox order, capture or payee ID, and no raw provider observation, is committed to the public repository.
- **What the lab needs to run:** no PayPal credentials, no live API calls and no OrderTruth cloud. It runs deterministically from a clean checkout.
- **Time:** the fixture's `observed_at` values are part of the invented fixture. The verifier injects a test clock for deterministic replay.
  - Freshness and grace are evaluated against that clock.
  - A historical real observation is never reinterpreted as fresh, because the lab contains none.
- **Same machinery:** the lab exercises the **same** obligation engine, the `handleOnce` inbox, the outbox and the verifier as production. Only the evidence authority differs.

### 6.3 Optional private real-Sandbox qualification mode (documented, not part of v3's core build)

- **What it is:** a separate mode that runs the ladder's single-process rungs against a guard using the **PayPal authority**.
  - It uses **fresh**, separately authorized Sandbox readbacks made with the owner's credentials.
  - The timestamps are the original ones; nothing is rewritten.
- **Where its evidence lives:** under git-ignored `.work/`, never committed. Proofs it produces state `authority: PAYPAL` and their observation times.
- **Authorization:** each use needs its own authorization for PayPal calls. **This design authorizes no PayPal calls.**

---

## 7. Evidence, coverage and missing orders

### 7.1 Path registry

The merchant declares every code path that can produce a business effect:

```ts
guard.declarePaths([
  { id: "checkout_return", effect: "CREATE_ORDER" },
  { id: "paypal_webhook", effect: "CREATE_ORDER" },
  { id: "fulfil_worker", effect: "DISPATCH" },
]);
```

- Every SDK call names its `pathId`. An undeclared ID is `REJECTED`.
- The registry is shipped as evidence.
- The Migration Agent (§9) proposes registry entries for any paths it finds.

### 7.2 Cloud ingest

- New authenticated endpoint: a per-merchant key, an HMAC over the body and timestamp, and a timestamp skew window.
- Replay protection: `event_id` uniqueness on the server side, so ingest is idempotent.
- Ingest **never** answers in the checkout path. When the cloud is unavailable, the outbox simply retries.
- In v3 the ingest is exercised in the lab and in tests only. The hosted judge flow does not receive merchant SDK traffic.

### 7.2a Shipper heartbeat

- **The heartbeat:** the shipper emits a `shipper.heartbeat` event at a fixed interval. It carries, **per destination**, the backlog depth and the age of the oldest undelivered event. It also carries the evidence-write failure counter (§5.4a) and the `build_id`.
- **"Telemetry healthy" for a capture** means both:
  - heartbeats arrived throughout the capture's grace period;
  - the backlog reported in the latest heartbeat was empty of events older than the capture's grace deadline.
- Otherwise the classification is `TELEMETRY_GAP`.
- **One reconciler for both:** the classification logic is a single v3 **reconciler** module. The cloud and the verifier both call it, so L8 tests the real code, not a harness copy.

### 7.3 Coverage states (per declared path, and per path found)

| State | Established by |
|---|---|
| `UNKNOWN` | Default. No sufficient evidence. |
| `UNPROTECTED` | A path is known (declared, or found by the agent or static analysis) that writes the effect without the SDK. |
| `INSTRUMENTED` | Observe-mode evidence received from the path (§8). |
| `ENFORCED` | The path's calls go through `*Once` (evidence shows claims). |
| `REPLAY_VERIFIED` | The path passed the required verifier ladder in a Proof of Protection. |
| `DEPLOYED_OBSERVED` | Evidence carrying a `build_id` matching the verified revision has been received from that path. |

Rules:
- **One function computes coverage:** a single v3 module that the cloud, the CLI and the verifier all call, from the registry, evidence and static findings.
- **Precedence:** `UNPROTECTED` overrides every other state. A known bypass on a path makes it `UNPROTECTED`, even if claims also arrive.
  - Apart from that, a path's state is the highest rung its evidence supports.
- **States can regress:** a new `build_id` without fresh evidence drops `DEPLOYED_OBSERVED`, and a newly found bypass drops the path to `UNPROTECTED`.
- **A missing report never turns a path green.**
- The strongest coverage claim is **"complete known-path coverage"**. It requires:
  - every *known* path is at least `ENFORCED`, and no known path is `UNKNOWN` or `UNPROTECTED`;
  - **no unreconciled `LEGACY_UNDATED` or `LEGACY_AMBIGUOUS` record** for the effect (§8).
  - It is never phrased as "all paths protected".
  - **Undiscovered paths remain an explicit limitation in every proof.** A path is "known" if it is declared, or found by the agent or by static analysis.
  - A merchant's own declaration that it has no other paths is recorded as a declaration, not as independent proof.

### 7.4 Missing orders

For a verified capture past its grace period (reusing v2's `DEFAULT_MISSING_ORDER_GRACE_MS` logic in `src/merchant/missing-order.ts`):

| Evidence | Classification |
|---|---|
| A committed obligation event for the capture | Order observed |
| No event, but SDK telemetry healthy for its paths | `SUSPECTED_MISSING`, or `TELEMETRY_GAP` if the shipper backlog is unknown |
| An authoritative merchant **reconciliation snapshot** shows zero matching orders | `MISSING_ESTABLISHED` for that snapshot time |

The **reconciliation snapshot** is a merchant-run SDK job, `guard.reportSnapshot(window)`. It runs the merchant's registered locator query for captures in a time window and ships counts as evidence.

---

## 8. Adoption lifecycle (merchants with history)

For each business effect, a merchant moves through `OBSERVE → BACKFILL → READY → ENFORCE`. A path can be rolled back to `OBSERVE` without deleting data.

1. **OBSERVE:** `guard.observe*()` records evidence about effects written by legacy code, without claiming anything. Coverage begins to fill in.
2. **BACKFILL:** `ordertruth backfill` (CLI) runs the merchant's locator over historical orders for a window. It inserts historical obligations marked `origin = BACKFILLED`.
   - **The window is configurable.** Its default minimum is PayPal's automatic retry horizon, 3 days, plus a margin.
   - That minimum is an investigation window, **not** proof that all history is covered. PayPal also allows events to be resent manually after the automatic retries end, and merchant-owned queues can replay older work.
   - Each backfill run records a **backfill snapshot**: its `taken_at`, plus the identity of every row it saw. A snapshot taken before `enforced_since` is independent evidence of pre-enforcement history (see legacy reconciliation below).
   - **The backfill applies the same cardinality rules.** Two or more orders for one intent or one capture are reported as duplicates and are never backfilled as a single obligation.
   - Historical orders may lack line items or other fingerprint fields. A backfilled row stores a **partial fingerprint** (capture ID, amount, currency) and is flagged `PARTIAL_FINGERPRINT`.
   - On reuse, a backfilled obligation matches on the fields it has. A redelivered pre-SDK webhook then gets `REUSED`, not a false conflict.
   - Existing duplicates or conflicts are listed in a backfill report and are **not** resolved automatically. Resolution goes through the existing human-approved recovery workflow, separately authorized.
3. **READY**, a gate computed by the SDK CLI. Every condition must hold:
   - the backfill is complete for the window;
   - every conflict is resolved or explicitly accepted;
   - every known path for the effect is migrated (the code calls `*Once`);
   - the backfill found no unresolved ambiguous (multiple-match) identities.
4. **ENFORCE:** turned on per path.
   - Until all paths are enforced, coverage reports **partial**.
   - Proofs must not claim integration-wide protection.

**Legacy identity reconciliation at claim time**, which covers replays of any age:

- **`enforced_since`:** when `ENFORCE` turns on for a path and effect, the SDK records `enforced_since`. The **effect's** `enforced_since` is the earliest across its enforced paths.

**How a legacy row's provenance is established.** A legacy row counts as **established pre-enforcement history** only with independent evidence that it existed before `enforced_since`:
- **(i)** its `created_at` (P1) or `paid_at` (P2) is before `enforced_since`; or
- **(ii)** it appears in a **backfill snapshot** whose `taken_at` is before `enforced_since` (§8 step 2), with the same identity.

Without either, its provenance is **uncertain**. An unprotected path could have written it after enforcement. Such rows:
- are flagged `LEGACY_UNDATED`;
- never produce a new effect, which is the safe direction;
- **block "complete known-path coverage" and any protection claim for the effect** until the row is independently reconciled, by a human review recorded as evidence.

**P1.** The registered `legacyOrdersForObligation` statement must return **every** active order for this intent **or** this capture, with no `LIMIT`, along with each row's capture ID, amount, currency and, where available, `created_at`.

| Found in step 6 | Outcome |
|---|---|
| No candidate rows | Create (step 7) |
| **Exactly one** row, matching, with established pre-enforcement history | `REUSED_LEGACY`. Provenance `ESTABLISHED`. |
| **Exactly one** row, matching, provenance uncertain | `REUSED_LEGACY`, flagged `LEGACY_UNDATED`. Provenance `UNCERTAIN`; coverage claims are blocked. |
| **Exactly one** row, matching, created **at or after** `enforced_since` | `BYPASS_DETECTED`. An unenforced path or an old deployment wrote it after enforcement began. No new order is created, and the effect's coverage shows `UNPROTECTED`. |
| **Exactly one** row that doesn't match (a different capture, intent or amount) | `IDENTITY_CONFLICT`. The claim is rolled back to S1, so this call takes no slot. |
| **Two or more** rows | `REJECTED: LEGACY_AMBIGUOUS`. The claim is rolled back to S1, and nothing is adopted or created. A `duplicate.detected` evidence event is emitted, which is an existing duplicate incident for human recovery. Protection claims for the effect are blocked. |

**P2.** The order locator runs under `FOR UPDATE`. It must return the status, amount, currency and **the bound capture ID**: P2 support requires the merchant's order to record which capture paid it. It may also return `paid_at`.

Before the order-state table applies, the SDK also runs `legacyPaidForCapture`, which returns **every** order bound to this capture, with no `LIMIT`:
- **No other order** bound to this capture: continue with the table below.
- **Any other order** bound to this capture: `IDENTITY_CONFLICT`, because one capture can't pay two orders.
- **Two or more orders**, which may include this one: `REJECTED: LEGACY_AMBIGUOUS`, with a `duplicate.detected` evidence event, no dispatch, and protection claims blocked.

| Order state | Outcome |
|---|---|
| `pending`, matching | Run the `markPaid` statement, giving `CREATED` |
| `paid`, bound to this capture, established pre-enforcement history (dated before `enforced_since`, or in a pre-enforcement backfill snapshot) | `LEGACY_ALREADY_PAID`, with **no dispatch**. Provenance `ESTABLISHED`. |
| `paid`, bound to this capture, provenance uncertain | `LEGACY_ALREADY_PAID`, flagged `LEGACY_UNDATED`, with no dispatch. Provenance `UNCERTAIN`; coverage claims are blocked. |
| `paid`, bound to this capture, `paid_at` at or after `enforced_since` | `BYPASS_DETECTED`, with no dispatch |
| `paid`, bound to a **different** capture | `IDENTITY_CONFLICT` |
| `paid`, with no bound capture recorded | `REJECTED: LEGACY_UNVERIFIABLE`, needing human review, with no dispatch |
| Any other status | `REJECTED: ORDER_STATE` |

The `markPaid` statement's `WHERE status='pending'` stays as a second safeguard.

**Mixed mode (some paths enforced, some not)**
- Under READ COMMITTED, an unenforced path can insert or update concurrently, and an enforced path can neither see nor lock that change before it commits. The SDK cannot prevent duplicates caused by unenforced paths.
- So while any known path for an effect is not `ENFORCED`:
  - the effect's coverage is **partial**;
  - L3 and L4 are asserted only among enforced paths;
  - proofs refuse any claim covering the whole effect (L10).
- `BYPASS_DETECTED` catches such writes **after the fact**.
- **Defence in depth (optional):** a merchant-authorized unique index on the merchant's own `orders(intent_id)` (P1). The backfill CLI can propose it after checking for existing duplicates. It is **never** applied automatically, because the SDK doesn't alter merchant tables.

**No legacy statement registered:** every proof and coverage report states "historical coverage limited to the backfill window [from, to]". `READY` additionally requires the merchant to acknowledge that limited coverage.

An empty obligations table on a merchant with history is exactly the failure this lifecycle prevents. `ENFORCE` is refused while `READY` is false, unless the merchant explicitly acknowledges a forced override, which is recorded in evidence and shown in every proof.

---

## 9. AI Migration Agent

**Job, stated narrowly:** given allowlisted merchant source, the declared contract profile and the SDK API, the agent must:
1. find every code path that produces the business effect;
2. propose the minimal correct migration onto `*Once` and `handleOnce`, including path registry entries and the identity mapping;
3. list what coverage remains uncertain, and why.

**Form:** a local CLI, `ordertruth migrate`, run by a developer on their own checkout.

**Inputs (and nothing else):**
- the allowlisted file globs;
- the SDK reference documentation;
- the contract profile;
- optionally, a sanitized incident trace.

The source is redacted with `src/redact.ts` rules plus secret-pattern scanning. Nothing is sent without the developer's explicit flag.

**Model:** the configured Gemini free-tier model, called through the existing guarded fetch pattern (`src/ai/investigator-eval/guard.ts`), with a call cap.

**Outputs:**
- a unified diff;
- a per-path claims list: call site, effect, identity fields used, confidence;
- the uncertain paths.

**Policy gate**, deterministic, applied before the diff reaches the verifier. A failure rejects the candidate. The diff:
- may modify only allowlisted files;
- may not change tests, the harness, the contract, the oracle or the ladder specs (hash-pinned);
- may not add dependencies, network calls, PayPal client calls or `fetch`;
- may make no schema change except adding the SDK migration;
- must stay under a size limit;
- must parse and typecheck.

**Baselines.** Each gets the **same** context:
- **B1, static analysis:** an AST search (ts-morph) for order-table writes: SQL text and query-builder calls on the effect table, through call graphs to their entry points. It reports paths only and makes no change.
- **B2, deterministic codemod:** wraps the call sites B1 found in `*Once`, using a fixed mapping rule for identity fields.
- **A, the agent.**

**Metrics**, objective, measured by the verifier:
- verified migrated paths;
- required paths left untouched;
- wrong identity mappings, where the ladder catches a conflict or reuse error;
- regressions, meaning existing merchant tests that fail;
- the human correction effort: lines edited before verification passes;
- uncertain-path recall against the corpus's known paths.

**Corpus:**
- integration variants built from one reference merchant domain: **V-A** route-level writes, **V-B** a service layer, **V-C** a queue worker, plus P2 pending-first variants;
- **plus held-out variants written by someone other than the agent's implementer, frozen and hashed before the agent's prompt is developed.**

The evaluation follows the existing preregistration discipline.

**No claim of AI superiority is made unless the agent beats both B1 and B2 on the frozen held-out variants.** If it ties, the honest claim is: the agent matched a codemod, and the guarantee comes from the SDK and the verifier.

---

## 10. Independent verifier: the counterexample ladder

`ordertruth verify --candidate <diff> --variant <id>` produces a verification report and a Proof of Protection.

**Isolation (hard requirement):**
- runs in a Linux container with **no network**, the source mounted read-only, and the candidate applied to a scratch copy;
- uses a fresh disposable PostgreSQL container and fixed CPU, memory and time limits;
- has no credentials of any kind;
- the same image runs locally (Docker) and in CI.

Model-written code never runs outside this container, and never on Render or Vercel. Without a container runtime, `verify` refuses to start.

**Immutable oracle.** The harness, the ladder specs, the contract and the negative controls are hash-pinned in a verifier manifest, following the `freeze-manifest.json` pattern from `ask-eval`. `verify` refuses on drift, and the policy gate already blocks edits to them.

**Validity checks**, run before a candidate is judged:
1. The **original** variant must **fail its declared reproduction rungs** (§12 table). If it passes them, the variant is invalid and the run aborts.
2. Every **negative control** must be **rejected**:

| Control | Description |
|---|---|
| NC1 | deduplicating on webhook event ID only |
| NC2 | suppressing order writes |
| NC3 | keying on `source_path` or the request ID |
| NC4 | a T2 P1 callback inserting the order row on another connection (must be `REJECTED: TX_PARTICIPATION`) |
| NC5 | leaving the worker path unmigrated |
| NC6 | a hardcoded capture ID |

If any control passes, the **verifier itself fails** and nothing is judged.

**The ladder.** A candidate is assessed rung by rung, and the report shows the first rung it fails.

| Rung | Scenario | Required outcome |
|---|---|---|
| L0 | Build, typecheck, existing merchant tests | Pass |
| L1 | First legitimate capture, single path | Exactly one matching effect |
| L2 | Same webhook redelivered (identical event ID) | No additional effect |
| L3 | Checkout return **and** webhook for one capture, in either order, with all known paths enforced | Both converge: one effect, the second call `REUSED` |
| L4 | Concurrent invocation from both paths, all enforced. Forced interleaving via barriers, plus a seeded stress run of N attempts | One effect. The losing call returns `REUSED`; a lock timeout is a **FAIL**. Seed recorded. |
| L5 | Process killed before `COMMIT` (child process, kill at an injected point) | Nothing from the operation persists: no obligation, effect, effect event or `claimed` evidence. The `capture_evidence` row and `capture.observed` event from issuance remain. A retry produces one effect. |
| L6 | Killed after `COMMIT`, before the reply or outbox shipping. The retry runs after the capability's freshness window has passed. | The effect is durable, and the retry gives `REUSED` (not `STALE`). **P2:** exactly one `fulfilment.dispatch` event ID exists, though it may be delivered more than once. **P1:** exactly one order row and exactly one `claimed` event; `reused` events carry distinct call IDs; if `order.created` is enabled, exactly one such event ID. |
| L7 | Two different legitimate captures | Two distinct effects, so legitimate fulfilment is preserved |
| L8 | Capture past grace with no effect | `SUSPECTED_MISSING` or `TELEMETRY_GAP` reported, never "healthy" |
| L9 | Identity mismatch (amount or currency, or a second capture on the same intent or order) | `IDENTITY_CONFLICT` or `REJECTED`. Both observations preserved. No reuse of an unrelated order. |
| L10 | A known path left unmigrated | Coverage shows `UNPROTECTED`. An integration-wide claim is refused. |
| L11 | Duplicate external effect from a consumer | **Recorded as a limitation** (§5.6), never a pass |
| L12 | OrderTruth cloud ingest unreachable throughout | All of L1–L7 hold. The `cloud_evidence` backlog grows and then drains once ingest returns. Fulfilment deliveries are unaffected. |
| L13 | A T2 callback makes an **extra** write on another connection | **Recorded as a T2 limitation**: not detected, and the proof says so. The *result-row* misuse (NC4) is rejected. |
| L14 | Same `event_id` delivered to `handleOnce` with a **changed** payload, and an `event_id` that doesn't match its payload's binding | `EVENT_CONFLICT`. `fn` not run. Both fingerprints preserved. An unchanged duplicate gets `REUSED`. |
| L15 | The `capture.observed` commit fails during issuance, through the shared issuance code (§6.1) | No capability issued, no effect, and a retry after recovery succeeds |
| L16 | Replays older than the backfill window. Each case has one required outcome. | **P1:** exactly one matching order from before enforcement → `REUSED_LEGACY` (`ESTABLISHED`); the same but undated and not in a pre-enforcement snapshot → `LEGACY_UNDATED` with coverage claims blocked; a non-matching order → `IDENTITY_CONFLICT`; a matching order created after `enforced_since` → `BYPASS_DETECTED`; two candidate orders → `LEGACY_AMBIGUOUS`, nothing adopted. **P2:** paid before enforcement → `LEGACY_ALREADY_PAID` with no dispatch; undated → `LEGACY_UNDATED` with claims blocked; paid after → `BYPASS_DETECTED`; no bound capture → `LEGACY_UNVERIFIABLE`; the capture bound to another order → `IDENTITY_CONFLICT`. Never a new order or a second dispatch. |
| L17 | Concurrency above the operation-pool and auxiliary-pool sizes | No deadlock. Operations that can't get a connection fail with a retryable error within the pool timeout, with nothing persisted. Survivors satisfy L4. |
| L18 | A partly enforced effect: one path enforced, one not | Duplicates from the unenforced path are **not** claimed as prevented. Coverage is partial, `BYPASS_DETECTED` is raised for a post-enforcement legacy write, and no claim covers the whole effect. |
| L19 | A T1 statement returns a row with one wrong identity field (for example a different `paid_capture_id` or `intent_id`), and a statement whose `returns` declaration omits one | `REJECTED: STATEMENT_POSTCONDITION`, with the claim rolled back. The guard refuses to start for the missing declaration. |
| L20 | A pre-transaction rejection (a bad HMAC) while the audit write fails | A retryable error is thrown and `REJECTED` is **not** returned. With the audit working: `REJECTED`, with durable evidence. |

**The tier is reported per path.** A T2 path can at best reach `REPLAY_VERIFIED (T2)`, and its proof always carries the L13 limitation.

**Concurrency mechanics (L4):**
- **Merchant-side barriers** are injected by the harness. It wraps the merchant's own awaited dependency, as REF-BUG-1's `afterCheck` does, without editing merchant code. The policy gate and the hash pins protect the harness.
- **SDK-side hook points** exist only when the SDK runs in verifier mode inside the container, and do nothing elsewhere.
- **A transaction blocked inside the claim `INSERT`** can't reach a barrier. The harness instead detects that it is waiting on a lock, through `pg_stat_activity.wait_event_type = 'Lock'`, and then releases the first transaction.

**Determinism:**
- Every run records the container image digest, the seed, the variant hash, the candidate diff hash, the harness hash and the timings.
- Rungs forced by barriers must give the same outcome on a rerun.
- Stress runs can't replay a PostgreSQL schedule exactly, so a stress run need only repeat its verdict.
- **A FAIL verdict is reported only if a barrier-forced interleaving reproduces it.** A stress-only failure is reported as `FLAKY` and blocks acceptance.

**Network:** "no network" means no route outside the run. The candidate container and its PostgreSQL container share an **internal-only** Docker network with no external gateway. That is allowed.

---

## 11. Assurance records

Both records are canonical JSON, hashed with SHA-256 using `src/domain/canonical.ts`. They are separate records with separate IDs.

**v2 is not refactored.** `src/merchant/contract.ts`, the receipts and the `repair_outcomes` tables stay exactly as they are.
- The v3 contract is a new file in the v3 package.
- The two contracts are related only through the mapping table and the compatibility tests in §4. They are distinct contracts, and equivalence is claimed only for the tested cases.
- A v3 Proof of Resolution is a **new record**. Where a hosted v2 receipt exists, it references that receipt by hash.

**Proof of Resolution** carries forward the fields of the existing v2 repair receipt (`src/merchant/postgres-recovery.ts`), referencing it rather than altering it:
- contract ID and version;
- incident ID and evidence hash;
- plan hash, approval mode and approver;
- before and after state;
- postcondition result;
- the provider claim, worded as *"stored PayPal evidence unchanged by this operation"*, never "PayPal unchanged";
- the receipt hash.

**Proof of Protection** is new:
- contract ID and version, SDK version, variant ID and source revision hash;
- candidate diff hash, and its origin (`AI_AGENT`, `CODEMOD_B2`, `HUMAN`, `REFERENCE_FIX`);
- the policy-gate result, the verifier manifest hash and the container image digest;
- the validity checks, with original-fails and negative-control results;
- per-rung results (`PASS`/`FAIL`/`NOT_RUN`/`LIMITATION`) with seeds;
- the coverage map, with each path's **tier** (T1 or T2), and the historical-coverage statement (§8);
- the capture provenance (the lab's fixture label, §18);
- the human review decision;
- an explicit `limitations` list (always including §5.6, and "not deployed, not production-verified" unless `DEPLOYED_OBSERVED`).

**Linking rule:** a Proof of Protection may reference a Proof of Resolution only through a `causal_link` field with an evidence type, such as the same capture and the same build observed. The lab and the hosted judge case are **not** linked in v3.

**Case status:** two independent fields, never a single "resolved":
- recovery: `DETECTED → DATA_RECOVERED`;
- protection: `NONE → PATCH_PROPOSED → PATCH_TESTED → DEPLOYED → POST_DEPLOY_VERIFIED`.

---

## 12. Reference integration (the lab)

New package `packages/lab-merchant`. The v2 SQLite `src/merchant/reference-merchant.ts` and its tests are **kept unchanged**.

- **The domain:** a minimal shop on PostgreSQL. It has a P1 profile (tables `orders`) and a P2 profile (tables `orders` with status, plus a `fulfilment_requests` consumer).
- **The handlers:** real HTTP handlers for checkout return and PayPal webhook, plus a worker. They are invoked by the verifier harness with controlled inputs built from the committed `SYNTHETIC_FIXTURE` (§6.2), under the test authority, and labelled as controlled test input.
- **The variants.** Each has a defined bug and the rungs that must reproduce it:

| Variant | Shape | Defect | Reproduction rungs (original must fail) |
|---|---|---|---|
| V-A | Route level: both routes write | REF-BUG-1: check, then `await`, then insert, with no unique key. Sequential calls are idempotent; only a concurrent race duplicates. | L4 |
| V-B | Shared order service | Each path builds its own "already ordered?" key (checkout session ID versus webhook event ID), so the two paths never see each other | L3 (and L4) |
| V-C | Queue worker | The worker consumes the capture message without claiming it, so a redelivered message creates a second order | L2 |
| V-P2 | Pending-first | `markPaid` is idempotent on order status, but the dispatch is emitted on every call, even when the order was already paid | L2, L3 |

Each variant's negative controls are chosen to fail on that variant's own defect.
- **The reference fix:** each variant also has a hand-written correct migration (origin `REFERENCE_FIX`). It proves the ladder can pass before any AI is involved.

---

## 13. Hosted judge integration (read-only)

- **The existing judge flow** is untouched: scenarios, detection, AI investigation, diagnostics, approval, execution and receipts.
- **A new read-only "Integration Lab" view** shows a small set of published Proof of Protection records.
  - They are committed as static evidence files under `docs/evidence/lab/` and served with the web build.
  - **Trusted build manifest:**
    - **Running the verifier:** a CI job runs `ordertruth verify` against a **source commit** S, the revision being verified. It writes the reports and a manifest at `docs/evidence/lab/manifest.json`.
    - **What the manifest records:** each report's SHA-256, the **source commit S**, the CI run ID and the container image digest.
    - **Publishing:** the users commit the reports and the manifest in a later **publication commit** P.
      - The manifest never contains P's own hash, which would be impossible because a commit can't contain its own hash.
      - The manifest refers only to S, which already existed.
    - **The web build:** it embeds the manifest's hashes at build time, and fails if any report file doesn't match. It also records the commit it was **built from** (P or later) as build metadata.
    - **What the page shows:** **"verified at source commit S (CI run Y); published in build commit P"**. It computes this from build-embedded hashes, never from a hash shipped next to the file.
  - **What this proves:** that the displayed reports are the ones the stated CI run recorded for source commit S. It is **not** an independent attestation that the execution was genuine. The reproducible `ordertruth verify` instructions are the independent check, and the page says so.
  - The page also shows the ladder, the coverage map, each path's tier, the origin and the limitations.
  - No endpoint executes, applies or verifies code.
- **Labelling:** "Reference integration, verified offline in an isolated container, using a synthetic PayPal-shaped fixture (no PayPal data). Separate from your judge case, which uses a genuine PayPal Sandbox observation."
- **README, demo video and Devpost text must keep the same split:**
  - synthetic integration verification (the lab);
  - genuine PayPal observation (the hosted flow).

  Neither may be described in terms that belong to the other.
- The repository includes reproducible instructions (`ordertruth verify …`) so anyone can regenerate the records.

---

## 14. Guarantee matrix

| Claim | Status in v3 |
|---|---|
| One verified capture → one local order (P1), for **T1** registered-statement paths | **Supported**, once verified on the variant |
| The same, for **T2** callback paths | **Conditional:** only if every callback write uses the supplied transaction. The SDK detects a result row committed elsewhere (NC4), but **not** extra side-writes (L13). |
| One pending order → one paid transition and one dispatch event (P2) | **Supported** (T1 always), once verified. Extra writes in the `after` hook are T2. |
| A changed event payload is never treated as a duplicate (`handleOnce`) | **Supported** (L14) |
| Every issued capability has durable capture evidence | **Supported** (fails closed, L15) |
| Replays older than the backfill window don't create a second effect | **Supported** with a registered legacy statement (L16). Otherwise historical coverage is limited to the stated window. |
| Duplicate, reordered or concurrent delivery is safe for the local effect | **Supported** (L2–L4) |
| Crash or restart safety for the local effect | **Supported** (L5, L6) |
| A cloud outage doesn't block the merchant operation | **Supported** (L12), given the merchant's own database is up |
| A conflicting payment identity is surfaced, not merged | **Supported** (L9) |
| Missing orders detected | **Partial:** suspected after grace; established only with a reconciliation snapshot |
| Duplicates caused by a not-yet-enforced path, while enforcement is partial | **Not prevented.** Detected after the fact as `BYPASS_DETECTED` where legacy statements exist; coverage stays partial (L18). |
| Every merchant path protected | **Not claimable.** The strongest claim is complete *known-path* coverage (§7.3); undiscovered paths remain a stated limitation. |
| Published lab proofs are the recorded results | **Supported** for consistency with the build manifest of a stated source commit and CI run, published in a stated build commit (§13). Not an independent attestation of execution. |
| Adopted legacy rows are genuinely pre-enforcement | **Only where established** (a timestamp before `enforced_since`, or a pre-enforcement backfill snapshot). Otherwise `LEGACY_UNDATED`, which blocks protection claims (§8). |
| Exactly-once external effects (shipping, email, APIs) | **Unsupported**; recorded as a limitation |
| PayPal data authentic | Only for `PAYPAL`-authority evidence that passed readback or webhook verification (the hosted flow; the optional private qualification mode) |
| Lab results reflect PayPal events | **Never claimed.** The lab uses `SYNTHETIC_FIXTURE` evidence under the test authority; it proves merchant-integration behaviour only. |
| Test evidence can't pass as genuine | **Supported:** runtime authority checks, separate keys, a guard flag gated by the environment, and a startup refusal (§6.1) |
| AI migrates integrations correctly | Only candidates that passed the verifier; superiority only if it beats B1 and B2 on the frozen held-out set |
| Patched code is production-safe | **Not established** by replay |
| Partial captures, refunds, subscriptions | **Unsupported** (future contracts) |

---

## 15. Test-first build order (for the builder's plan)

Each step lands with its tests first, and the next step starts only once the previous one is green.

1. The contract file (P1 and P2) and the identity and fingerprint functions, with unit tests.
2. The SDK tables and migration. Then `createOrderOnce` in its **T1 statement form**, with PostgreSQL tests for claim, reuse, conflict, rollback, concurrency via barriers and legacy reconciliation. Then the **T2 callback form**, with the result-row participation test (NC4) and the side-write limitation test (L13).
3. `markPaidOnce` (T1 only), with the P2 order-state table (§8). Then the outcome table (§5.3d), tested row by row, with evidence asserted in the transaction. Then the two pools and the L17 behaviour. Then `consume` and `handleOnce`, with the delivery states, binding, reuse, `EVENT_CONFLICT` and poisoning (L14). Then the `cloud_evidence` shipper, with ingest stubbed, an outage simulated and leases expired.
4. `CaptureVerifier`: the HMAC capability, freshness and binding. Then the separate `TestCaptureAuthority` and the committed `SYNTHETIC_FIXTURE`, with tests that test capabilities are rejected by a production guard and that the production entry point never loads the testing module.
5. The lab merchant variants and their reference fixes.
6. The verifier container: the manifest, the validity checks and the ladder L0–L20. All negative controls are rejected and all reference fixes pass.
7. The assurance record builders, the CI job and its build manifest, and the Integration Lab read-only view with build-embedded hashes.
8. Baselines B1 and B2, then the Migration Agent and its policy gate, all offline with mocked model output.
9. The corpus freeze, then the preregistered evaluation, which needs its own authorization for any live model calls.

**Rollback:** every step is additive (new packages, the new `ordertruth_guard` schema in **merchant** databases only, a new view). Removing v3 means removing those packages and the view. No existing table, route or test changes.

---

## 16. Left to the builder

- Package and file names inside `packages/*`; internal module structure.
- The HMAC algorithm and key handling for `capabilityKey`; the ingest authentication format; outbox backoff parameters; default timeouts.
- The exact detection of "committed outside the transaction" (§5.4 case 3), provided it is tested.
- The container tooling (Docker Compose or another), provided the isolation rules in §10 hold.
- The UI layout of the Integration Lab view, within the existing judge design system.
- The AST tooling for B1 and B2 (ts-morph is suggested).

## 17. Calls made in this document (please check)

These were not discussed explicitly; I chose them.

1. **Schema:** a separate `ordertruth_guard` PostgreSQL schema for all SDK tables, in the **merchant's** database. The name `ordertruth` is the cloud's (§5.1).
2. **Second unique indexes:** in P1, one intent can't get two orders from two captures; in P2, one capture can't pay two orders.
3. **Readback required before fulfilment:** a verified webhook alone is evidence, not authority to fulfil.
4. **Capability format:** an HMAC-keyed in-process capability, documented as a guard against mistakes, not against a compromised server.
5. **Backfill window:** at least 3 days plus a margin, to match PayPal's webhook retry horizon.
6. **Coverage claim:** "complete" requires every known path to be at least `ENFORCED`.
7. **Lab and hosted case:** not linked in v3, as decided.
8. **Model-written code:** runs only inside the verifier container. `verify` refuses to start without a container runtime.
9. **Packages:** new workspace packages `packages/guard` and `packages/lab-merchant`. The verifier and agent CLIs live under the same workspace.
10. **Builder-review fixes, made after the review below:**
    - the `ordertruth_guard` schema, with separate merchant and cloud databases;
    - line items read from the intent locator;
    - a primary-key conflict target plus a savepoint;
    - a participation check through an independent connection instead of `xmin`;
    - rejection evidence written after the rollback;
    - evidence IDs per call, with `REUSED` emitting evidence;
    - shared, serializable capabilities;
    - `capture.observed` events and the shipper heartbeat;
    - one reconciler and one coverage function, with `UNPROTECTED` taking precedence;
    - partial fingerprints for backfilled rows;
    - a defined defect and reproduction rungs for each variant;
    - the L4 mechanics, with a lock timeout counting as FAIL;
    - an internal-only container network;
    - v2 left untouched, with a mapping table.
11. **Design-approval review fixes** (§18):
    - guarantee tiers T1–T3, with registered statements as the guaranteed form and P2 always T1;
    - the participation check limited to inserted result rows;
    - `handleOnce` with a fingerprint and binding check, plus `EVENT_CONFLICT`;
    - outbox delivery tracked per destination;
    - `capture.observed` failing closed;
    - legacy reconciliation at claim time, with the 3-day window as a configurable minimum only;
    - distinct v2 and v3 contracts, with compatibility tests;
    - a CI build manifest with build-embedded hashes;
    - "complete known-path coverage" as the strongest coverage claim.
12. **Focused §5 review fixes** (§18):
    - a per-outcome commit table, with every decided outcome's evidence committed in the transaction through savepoint S1;
    - freshness checked only on the claim path, so a stale retry still gets `REUSED`;
    - `enforced_since` used to tell legacy writes from bypasses (`BYPASS_DETECTED`), and the P2 order state classified under `FOR UPDATE` before `markPaid`;
    - P2 support requires the merchant's order to record its bound capture;
    - in v3, consumers share the merchant database and pull their deliveries, with the acknowledgement atomic with the effect, defined delivery states, and `POISONED` and `CONFLICT` terminal;
    - mixed mode declared partial: duplicates from unenforced paths are not prevented, and a merchant-side unique index is offered but never applied automatically;
    - an auxiliary pool with finite timeouts, so there is no circular wait;
    - exact oracles for L5, L6 and L16, plus new rungs L17 and L18.
13. **Final consistency amendments** (§18):
    - one physical primary key, `(merchant_id, operation_kind, obligation_key)`, with a database-generated canonical key, partial unique indexes and `CHECK`s;
    - legacy provenance established only by a timestamp or a pre-enforcement backfill snapshot, so undated rows are uncertain and block claims;
    - cardinality checks over all candidate legacy rows, with multiple matches giving `LEGACY_AMBIGUOUS`;
    - postconditions checking the full operation identity, including `paid_capture_id`, with required `returns` declarations;
    - a pre-transaction rejection audit that throws if it fails;
    - source commit separated from publication commit;
    - new rungs L19 and L20.

## 18. Builder review (2026-10-30) and decisions

An independent reviewer read this document as its builder would, and checked its claims against the code. It raised 13 questions. Two contradicted the code and were confirmed:
- the schema name collided with the cloud's `ordertruth` schema;
- v2 stores only a masked payee ID.

Twelve are resolved in the sections above (§17, call 10).

**Decided by the decision-maker (2026-10-30): option (b), a synthetic fixture.** The public lab uses an invented, PayPal-shaped `SYNTHETIC_FIXTURE` under a separate test authority (§6.1–6.2). The reasons given:
- anyone can reproduce it without credentials;
- old evidence is never presented as fresh;
- no genuine transaction references are published;
- testing is deterministic;
- the hosted flow already provides the genuine PayPal observation.

Genuine Sandbox IDs and raw provider observations are not committed. The hosted v2 evidence and its provenance are unchanged. A private real-Sandbox qualification mode is documented as optional (§6.3), and no PayPal calls are authorized by this design.

Rejected: (a), committing a redacted copy of the real Sandbox readback with a salted-hash payee.

**Design-approval review (2026-10-30, conditional NO-GO), and the seven amendments made:**
1. **§5.4:** checking from an independent connection doesn't prove a callback wrote inside the transaction, because an uncommitted update leaves the old row visible under MVCC.
   - The guaranteed form is now SDK-executed registered statements (T1), and P2's transition is always T1.
   - The check survives only for inserted P1 result rows, where it is sound.
   - Side-writes in T2 callbacks are a published limitation (L13).
2. **§5.5:** `handleOnce` now stores the payload fingerprint and binding, returns `REUSED` for an unchanged duplicate, and returns `EVENT_CONFLICT` for a changed payload, without running `fn` (L14).
3. **§5.5 and §7.2:** delivery is tracked per destination in `outbox_deliveries`. A cloud acknowledgement never completes a fulfilment delivery.
4. **§6:** a capability is issued only after the capture evidence and `capture.observed` have committed (fails closed, L15).
5. **§8:** the 3-day window is a configurable minimum. Legacy identity reconciliation at claim time covers older replays (L16); without it, coverage is declared limited.
6. **§4 and §11:** v2 and v3 are distinct, versioned contracts, with a mapping table and compatibility tests.
7. **§13 and §14:** proof hashes are pinned in a CI build manifest and embedded at build time, explicitly not an attestation. Coverage is claimed only as "complete known-path coverage".

A focused builder review of §5 (transaction protocol, inbox, outbox) follows these amendments.

**Focused builder review of §5 (2026-10-30): 8 findings, all resolved in this revision.**
1. **The claim row's fate is now defined for every outcome** (§5.3d table). Rolled-back claims never occupy a slot, so a mismatched replay can't block the legitimate capture.
2. **P2's step order is fixed.** The order state is classified under `FOR UPDATE` before `markPaid`. `enforced_since` tells a legacy write from a bypass. P2 requires the merchant's order to record its bound capture (§8).
3. **Evidence for every decided outcome commits in the transaction** through savepoint S1. Best effort applies only to an unusable transaction, and no rung asserts best-effort evidence.
4. **Consumer transport is specified.** Consumers pull from the shared merchant database, and the acknowledgement is atomic with the effect. The delivery states are defined, with `POISONED` and `CONFLICT` terminal.
5. **Mixed mode is declared partial,** and the SDK can't prevent duplicates from unenforced paths (L18). `BYPASS_DETECTED` catches them after the fact, and the optional merchant index is never automatic.
6. **Freshness is checked only on the claim path,** so a stale retry gets `REUSED` (L6).
7. **The L5, L6, L15 and L16 oracles are exact,** and both authorities share one issuance path.
8. **An auxiliary pool with finite timeouts** removes the circular wait (L17).

**Final design review (2026-10-30): 5 targeted amendments made.**
1. **One physical primary key**, `(merchant_id, operation_kind, obligation_key)`, replaces the two incompatible primary keys of §5.2.
   - `obligation_key` is a database-generated, versioned canonical encoding of the P1 or P2 identity, guarded by `CHECK`s.
   - The secondary rules are partial unique indexes.
   - The `ON CONFLICT` target is exactly that key (§5.2a, §5.3c).
2. **Unknown legacy timestamps are no longer proof of pre-enforcement history.** Provenance needs a timestamp before `enforced_since` or a pre-enforcement backfill snapshot. Otherwise the row is `LEGACY_UNDATED`, and coverage and protection claims are blocked until it is reconciled (§8, §7.3, §14).
3. **Legacy reconciliation checks every candidate row**, by intent or capture for P1 and by bound capture for P2. Two or more matches give `LEGACY_AMBIGUOUS` (nothing adopted, a duplicate incident raised), and the backfill applies the same rule (§8).
4. **T1 postconditions check the full operation identity**, including `paid_capture_id` for P2, and statements must declare their returned identity columns (§5.3a, L19).
5. **Smaller corrections:**
   - Pre-transaction rejections are recorded in an audit transaction, and if it fails the SDK throws rather than returning `REJECTED` (§5.3c, §5.4a, L20).
   - The stale §17 schema entry now reads `ordertruth_guard`.
   - The lab manifest records the source commit verified, separately from the later publication commit (§13).
