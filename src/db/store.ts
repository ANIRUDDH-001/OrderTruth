import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ATTEMPT_STATES, TRANSITIONS, type AttemptState } from "../domain/checkout.ts";

/**
 * SQLite persistence via Node's built-in `node:sqlite` (ADR-004). All access goes through
 * this module so a later swap (better-sqlite3 / Postgres) touches one file.
 * Not certified for multi-instance production (D6); multi-process tests cover one host only.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE checkout_intents (
     id TEXT PRIMARY KEY,
     sku TEXT NOT NULL,
     currency TEXT NOT NULL CHECK (currency = 'USD'),
     amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
     correlation_id TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE payment_attempts (
     id TEXT PRIMARY KEY,
     intent_id TEXT NOT NULL UNIQUE REFERENCES checkout_intents(id),
     paypal_order_id TEXT UNIQUE,
     create_request_id TEXT NOT NULL UNIQUE,
     capture_request_id TEXT NOT NULL UNIQUE,
     state TEXT NOT NULL,
     provider_order_status TEXT,
     capture_id TEXT UNIQUE,
     capture_status TEXT,
     captured_minor INTEGER,
     captured_currency TEXT,
     payee_merchant_masked TEXT,
     verdict_reasons TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE evidence (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     attempt_id TEXT REFERENCES payment_attempts(id),
     evidence_class TEXT NOT NULL CHECK (evidence_class IN
       ('PAYPAL_API_READBACK','PAYPAL_API_RESPONSE','PAYPAL_VERIFIED_WEBHOOK','MERCHANT_DB_OBSERVED','CONTROLLED_FAULT_INJECTION','AI_HYPOTHESIS','OPERATOR_STATEMENT')),
     operation TEXT NOT NULL,
     http_status INTEGER,
     paypal_debug_id TEXT,
     request_id TEXT,
     correlation_id TEXT NOT NULL,
     duration_ms INTEGER,
     summary_json TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
   CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;`,
  // Gate 1A: durable checkout key, claim bookkeeping, and the DB-enforced state machine. The
  // transition rows are a literal copy of domain TRANSITIONS (a test asserts equality); changing
  // TRANSITIONS needs a new migration. Additive only: existing rows and values are untouched.
  `ALTER TABLE checkout_intents ADD COLUMN checkout_key TEXT;
   CREATE UNIQUE INDEX checkout_intents_checkout_key ON checkout_intents(checkout_key);
   ALTER TABLE payment_attempts ADD COLUMN capture_claims INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE payment_attempts ADD COLUMN capture_claimed_at_ms INTEGER;
   CREATE TABLE attempt_transitions (from_state TEXT NOT NULL, to_state TEXT NOT NULL, PRIMARY KEY (from_state, to_state)) WITHOUT ROWID;
   INSERT INTO attempt_transitions (from_state, to_state) VALUES
     ('created','awaiting_buyer_approval'),
     ('awaiting_buyer_approval','approved'), ('awaiting_buyer_approval','captured'), ('awaiting_buyer_approval','pending'),
     ('awaiting_buyer_approval','denied'), ('awaiting_buyer_approval','uncertain'), ('awaiting_buyer_approval','mismatch'),
     ('approved','capture_in_progress'), ('approved','captured'), ('approved','pending'), ('approved','denied'),
     ('approved','uncertain'), ('approved','mismatch'),
     ('capture_in_progress','captured'), ('capture_in_progress','pending'), ('capture_in_progress','denied'),
     ('capture_in_progress','uncertain'), ('capture_in_progress','mismatch'),
     ('uncertain','capture_in_progress'), ('uncertain','captured'), ('uncertain','pending'), ('uncertain','denied'), ('uncertain','mismatch'),
     ('pending','captured'), ('pending','denied'), ('pending','uncertain'), ('pending','mismatch');
   CREATE TRIGGER attempt_transitions_static_i BEFORE INSERT ON attempt_transitions BEGIN SELECT RAISE(ABORT, 'attempt_transitions is static'); END;
   CREATE TRIGGER attempt_transitions_static_u BEFORE UPDATE ON attempt_transitions BEGIN SELECT RAISE(ABORT, 'attempt_transitions is static'); END;
   CREATE TRIGGER attempt_transitions_static_d BEFORE DELETE ON attempt_transitions BEGIN SELECT RAISE(ABORT, 'attempt_transitions is static'); END;
   CREATE TRIGGER payment_attempts_initial_state BEFORE INSERT ON payment_attempts WHEN NEW.state <> 'created'
     BEGIN SELECT RAISE(ABORT, 'illegal attempt state transition: new attempts start as created'); END;
   CREATE TRIGGER payment_attempts_state_guard BEFORE UPDATE OF state ON payment_attempts
     WHEN OLD.state <> NEW.state AND NOT EXISTS (SELECT 1 FROM attempt_transitions WHERE from_state = OLD.state AND to_state = NEW.state)
     BEGIN SELECT RAISE(ABORT, 'illegal attempt state transition'); END;`,
  // Gate 1B: webhook inbox. A delivery row is written for every request before any decision; only
  // a PayPal-verified delivery may create an event row, so the event id (the dedup key) can never be
  // claimed by unverified input. States are guarded by a static transition table, and every state
  // change is copied into an append-only audit table by triggers (no code path can skip it).
  // Additive only. Raw bodies are never stored: a SHA-256 plus an allowlisted summary.
  `CREATE TABLE webhook_deliveries (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     state TEXT NOT NULL,
     claimed_event_id TEXT,
     claimed_event_type TEXT,
     transmission_id TEXT,
     transmission_time TEXT,
     body_sha256 TEXT NOT NULL,
     body_bytes INTEGER NOT NULL,
     reason TEXT,
     correlation_id TEXT NOT NULL,
     verify_ms INTEGER,
     verify_debug_id TEXT,
     received_at_ms INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX webhook_deliveries_claimed_event ON webhook_deliveries(claimed_event_id);
   CREATE INDEX webhook_deliveries_state ON webhook_deliveries(state, received_at_ms);
   CREATE TABLE webhook_events (
     event_id TEXT PRIMARY KEY,
     event_type TEXT NOT NULL,
     resource_type TEXT,
     event_create_time TEXT,
     first_delivery_seq INTEGER NOT NULL UNIQUE REFERENCES webhook_deliveries(seq),
     deliveries INTEGER NOT NULL DEFAULT 1,
     state TEXT NOT NULL,
     order_id TEXT,
     attempt_id TEXT REFERENCES payment_attempts(id),
     process_attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
     lease_until_ms INTEGER,
     outcome TEXT,
     summary_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX webhook_events_due ON webhook_events(state, next_attempt_at_ms);
   CREATE TABLE webhook_transitions (subject TEXT NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL, PRIMARY KEY (subject, from_state, to_state)) WITHOUT ROWID;
   INSERT INTO webhook_transitions (subject, from_state, to_state) VALUES
     ('delivery','received_unverified','verified'), ('delivery','received_unverified','duplicate'),
     ('delivery','received_unverified','rejected'), ('delivery','received_unverified','retryable_failure'),
     ('delivery','received_unverified','abandoned'),
     ('event','verified_pending','processing'), ('event','retryable_failure','processing'),
     ('event','processing','processed'), ('event','processing','foreign'), ('event','processing','ignored'),
     ('event','processing','disagreed'), ('event','processing','retryable_failure'), ('event','processing','failed');
   CREATE TRIGGER webhook_transitions_static_i BEFORE INSERT ON webhook_transitions BEGIN SELECT RAISE(ABORT, 'webhook_transitions is static'); END;
   CREATE TRIGGER webhook_transitions_static_u BEFORE UPDATE ON webhook_transitions BEGIN SELECT RAISE(ABORT, 'webhook_transitions is static'); END;
   CREATE TRIGGER webhook_transitions_static_d BEFORE DELETE ON webhook_transitions BEGIN SELECT RAISE(ABORT, 'webhook_transitions is static'); END;
   CREATE TABLE webhook_audit (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     subject TEXT NOT NULL,
     subject_id TEXT NOT NULL,
     from_state TEXT,
     to_state TEXT NOT NULL,
     reason TEXT,
     at TEXT NOT NULL
   );
   CREATE TRIGGER webhook_audit_no_update BEFORE UPDATE ON webhook_audit BEGIN SELECT RAISE(ABORT, 'webhook_audit is append-only'); END;
   CREATE TRIGGER webhook_audit_no_delete BEFORE DELETE ON webhook_audit BEGIN SELECT RAISE(ABORT, 'webhook_audit is append-only'); END;
   CREATE TRIGGER webhook_deliveries_no_delete BEFORE DELETE ON webhook_deliveries BEGIN SELECT RAISE(ABORT, 'webhook deliveries are append-only'); END;
   CREATE TRIGGER webhook_events_no_delete BEFORE DELETE ON webhook_events BEGIN SELECT RAISE(ABORT, 'webhook events are append-only'); END;
   CREATE TRIGGER webhook_deliveries_initial BEFORE INSERT ON webhook_deliveries WHEN NEW.state <> 'received_unverified'
     BEGIN SELECT RAISE(ABORT, 'illegal webhook delivery state: deliveries start as received_unverified'); END;
   CREATE TRIGGER webhook_deliveries_guard BEFORE UPDATE OF state ON webhook_deliveries
     WHEN OLD.state <> NEW.state AND NOT EXISTS (SELECT 1 FROM webhook_transitions WHERE subject = 'delivery' AND from_state = OLD.state AND to_state = NEW.state)
     BEGIN SELECT RAISE(ABORT, 'illegal webhook delivery state transition'); END;
   CREATE TRIGGER webhook_events_initial BEFORE INSERT ON webhook_events
     WHEN NEW.state <> 'verified_pending'
       OR NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.seq = NEW.first_delivery_seq AND d.state = 'verified' AND d.claimed_event_id = NEW.event_id)
     BEGIN SELECT RAISE(ABORT, 'webhook event requires a PayPal-verified delivery of the same event id'); END;
   CREATE TRIGGER webhook_events_guard BEFORE UPDATE OF state ON webhook_events
     WHEN OLD.state <> NEW.state AND NOT EXISTS (SELECT 1 FROM webhook_transitions WHERE subject = 'event' AND from_state = OLD.state AND to_state = NEW.state)
     BEGIN SELECT RAISE(ABORT, 'illegal webhook event state transition'); END;
   CREATE TRIGGER webhook_deliveries_audit_i AFTER INSERT ON webhook_deliveries
     BEGIN INSERT INTO webhook_audit (subject, subject_id, from_state, to_state, reason, at) VALUES ('delivery', NEW.seq, NULL, NEW.state, NEW.reason, NEW.updated_at); END;
   CREATE TRIGGER webhook_deliveries_audit_u AFTER UPDATE OF state ON webhook_deliveries WHEN OLD.state <> NEW.state
     BEGIN INSERT INTO webhook_audit (subject, subject_id, from_state, to_state, reason, at) VALUES ('delivery', NEW.seq, OLD.state, NEW.state, NEW.reason, NEW.updated_at); END;
   CREATE TRIGGER webhook_events_audit_i AFTER INSERT ON webhook_events
     BEGIN INSERT INTO webhook_audit (subject, subject_id, from_state, to_state, reason, at) VALUES ('event', NEW.event_id, NULL, NEW.state, 'delivery ' || NEW.first_delivery_seq, NEW.updated_at); END;
   CREATE TRIGGER webhook_events_audit_u AFTER UPDATE OF state ON webhook_events WHEN OLD.state <> NEW.state
     BEGIN INSERT INTO webhook_audit (subject, subject_id, from_state, to_state, reason, at) VALUES ('event', NEW.event_id, OLD.state, NEW.state, NEW.outcome, NEW.updated_at); END;`,
];

export type IntentRow = { id: string; sku: string; currency: "USD"; amount_minor: number; correlation_id: string; checkout_key: string | null; created_at: string };
export type AttemptRow = {
  id: string;
  intent_id: string;
  paypal_order_id: string | null;
  create_request_id: string;
  capture_request_id: string;
  state: AttemptState;
  provider_order_status: string | null;
  capture_id: string | null;
  capture_status: string | null;
  captured_minor: number | null;
  captured_currency: string | null;
  payee_merchant_masked: string | null;
  verdict_reasons: string | null;
  /** Number of capture claims ever taken; each claim precedes at most one capture POST. */
  capture_claims: number;
  /** Epoch ms of the latest claim (service clock). Drives the stale-claim and settle windows. */
  capture_claimed_at_ms: number | null;
  created_at: string;
  updated_at: string;
};
export type AttemptPatch = Partial<Pick<AttemptRow,
  "paypal_order_id" | "provider_order_status" | "capture_id" | "capture_status" | "captured_minor" | "captured_currency" | "payee_merchant_masked" | "verdict_reasons" | "create_request_id" | "capture_request_id"
>>;
const PATCHABLE = new Set<string>([
  "paypal_order_id", "provider_order_status", "capture_id", "capture_status", "captured_minor", "captured_currency",
  "payee_merchant_masked", "verdict_reasons", "create_request_id", "capture_request_id",
]);
export type EvidenceInput = {
  attemptId: string | null;
  evidenceClass: "PAYPAL_API_READBACK" | "PAYPAL_API_RESPONSE" | "PAYPAL_VERIFIED_WEBHOOK" | "MERCHANT_DB_OBSERVED" | "CONTROLLED_FAULT_INJECTION" | "AI_HYPOTHESIS";
  operation: string;
  httpStatus: number | null;
  debugId: string | null;
  requestId: string | null;
  correlationId: string;
  durationMs: number | null;
  /** Must already be redacted by the caller. */
  summary: unknown;
};

const now = () => new Date().toISOString();

function patchColumns(patch: AttemptPatch): { keys: string[]; values: Array<string | number | null> } {
  const keys = Object.keys(patch);
  for (const k of keys) if (!PATCHABLE.has(k)) throw new Error(`illegal column ${k}${k === "state" ? " (state changes only via transition/claimCapture)" : ""}`);
  return { keys, values: keys.map((k) => (patch[k as keyof AttemptPatch] ?? null) as string | number | null) };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string, opts: { busyTimeoutMs?: number } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${Math.max(0, Math.trunc(opts.busyTimeoutMs ?? 5000))};`);
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.#migrate();
  }

  #migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    this.tx(() => {
      // Re-read inside the write lock so two processes starting together cannot both migrate.
      const row = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
      for (let v = row.v; v < MIGRATIONS.length; v++) {
        this.db.exec(MIGRATIONS[v]!);
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, now());
      }
    });
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Insert an intent and its single attempt. With a checkout key the insert is idempotent across
   * processes (unique index + ON CONFLICT DO NOTHING); returns false when the key already existed.
   */
  createIntentWithAttempt(
    intent: Omit<IntentRow, "created_at" | "checkout_key"> & { checkout_key?: string | null },
    attempt: { id: string; createRequestId: string; captureRequestId: string },
  ): boolean {
    const ts = now();
    return this.tx(() => {
      const r = this.db
        .prepare("INSERT INTO checkout_intents (id, sku, currency, amount_minor, correlation_id, checkout_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .run(intent.id, intent.sku, intent.currency, intent.amount_minor, intent.correlation_id, intent.checkout_key ?? null, ts);
      if (Number(r.changes) !== 1) return false;
      this.db
        .prepare(
          "INSERT INTO payment_attempts (id, intent_id, create_request_id, capture_request_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'created', ?, ?)",
        )
        .run(attempt.id, intent.id, attempt.createRequestId, attempt.captureRequestId, ts, ts);
      return true;
    });
  }

  /** Non-state fields only. State changes go through `transition` / `claimCapture`. */
  updateAttempt(id: string, patch: AttemptPatch) {
    const { keys, values } = patchColumns(patch);
    if (keys.length === 0) return;
    this.db.prepare(`UPDATE payment_attempts SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
  }

  /**
   * Guarded transition: one compare-and-set UPDATE that applies only when the current state is a
   * legal predecessor of `to` (optionally narrowed to `from`) and, if given, the claim counter is
   * unchanged. Returns whether it applied. The DB trigger enforces the same table independently.
   */
  transition(id: string, to: AttemptState, patch: AttemptPatch = {}, from?: AttemptState | readonly AttemptState[], guard: { captureClaims?: number } = {}): boolean {
    let froms: AttemptState[] = ATTEMPT_STATES.filter((s) => TRANSITIONS[s].includes(to));
    if (from !== undefined) {
      const want: readonly AttemptState[] = typeof from === "string" ? [from] : from;
      froms = froms.filter((s) => want.includes(s));
    }
    if (froms.length === 0) return false;
    const { keys, values } = patchColumns(patch);
    const set = ["state = ?", ...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
    const claims = guard.captureClaims !== undefined ? [guard.captureClaims] : [];
    const r = this.db
      .prepare(`UPDATE payment_attempts SET ${set} WHERE id = ? AND state IN (${froms.map(() => "?").join(", ")})${claims.length ? " AND capture_claims = ?" : ""}`)
      .run(to, ...values, now(), id, ...froms, ...claims);
    return Number(r.changes) === 1;
  }

  /** Update non-state fields only while the row is still in `state` (and claim counter, if given). */
  refresh(id: string, state: AttemptState, patch: AttemptPatch, guard: { captureClaims?: number } = {}): boolean {
    const { keys, values } = patchColumns(patch);
    const claims = guard.captureClaims !== undefined ? [guard.captureClaims] : [];
    const r = this.db
      .prepare(`UPDATE payment_attempts SET ${[...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ")} WHERE id = ? AND state = ?${claims.length ? " AND capture_claims = ?" : ""}`)
      .run(...values, now(), id, state, ...claims);
    return Number(r.changes) === 1;
  }

  /** Store the provider order id exactly once (first writer wins, across processes). */
  attachOrder(id: string, orderId: string, providerStatus: string | null): boolean {
    const r = this.db
      .prepare(
        "UPDATE payment_attempts SET paypal_order_id = ?, provider_order_status = ?, state = 'awaiting_buyer_approval', updated_at = ? WHERE id = ? AND state = 'created' AND paypal_order_id IS NULL",
      )
      .run(orderId, providerStatus, now(), id);
    return Number(r.changes) === 1;
  }

  /**
   * Compare-and-set claim so only one caller, in any process, can move an attempt into
   * capture_in_progress. The claim is committed before the capture POST. `uncertain` is claimable
   * only when `settledBeforeMs` is given and the previous claim is at least that old.
   */
  claimCapture(id: string, fromStates: readonly AttemptState[], o: { nowMs?: number; settledBeforeMs?: number } = {}): boolean {
    const froms = fromStates.filter((s) => TRANSITIONS[s].includes("capture_in_progress") && (s !== "uncertain" || o.settledBeforeMs !== undefined));
    if (froms.length === 0) return false;
    const r = this.db
      .prepare(
        `UPDATE payment_attempts SET state = 'capture_in_progress', capture_claims = capture_claims + 1, capture_claimed_at_ms = ?, updated_at = ?
         WHERE id = ? AND state IN (${froms.map(() => "?").join(", ")})
           AND (state <> 'uncertain' OR capture_claimed_at_ms IS NULL OR capture_claimed_at_ms <= ?)`,
      )
      .run(o.nowMs ?? Date.now(), now(), id, ...froms, o.settledBeforeMs ?? -1);
    return Number(r.changes) === 1;
  }

  getAttemptByOrderId(orderId: string): AttemptRow | undefined {
    return this.db.prepare("SELECT * FROM payment_attempts WHERE paypal_order_id = ?").get(orderId) as AttemptRow | undefined;
  }

  getAttempt(id: string): AttemptRow | undefined {
    return this.db.prepare("SELECT * FROM payment_attempts WHERE id = ?").get(id) as AttemptRow | undefined;
  }

  getAttemptByIntentId(intentId: string): AttemptRow | undefined {
    return this.db.prepare("SELECT * FROM payment_attempts WHERE intent_id = ?").get(intentId) as AttemptRow | undefined;
  }

  getIntent(id: string): IntentRow | undefined {
    return this.db.prepare("SELECT * FROM checkout_intents WHERE id = ?").get(id) as IntentRow | undefined;
  }

  getIntentByCheckoutKey(key: string): IntentRow | undefined {
    return this.db.prepare("SELECT * FROM checkout_intents WHERE checkout_key = ?").get(key) as IntentRow | undefined;
  }

  listAttempts(): AttemptRow[] {
    return this.db.prepare("SELECT * FROM payment_attempts ORDER BY created_at").all() as AttemptRow[];
  }

  /** Attempts whose payment outcome is not settled locally and that have a provider order to read. */
  listUnsettled(): AttemptRow[] {
    return this.db
      .prepare("SELECT * FROM payment_attempts WHERE state IN ('capture_in_progress', 'uncertain', 'pending') AND paypal_order_id IS NOT NULL ORDER BY created_at")
      .all() as AttemptRow[];
  }

  appendEvidence(e: EvidenceInput): number {
    const r = this.db
      .prepare(
        `INSERT INTO evidence (attempt_id, evidence_class, operation, http_status, paypal_debug_id, request_id, correlation_id, duration_ms, summary_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.attemptId, e.evidenceClass, e.operation, e.httpStatus, e.debugId, e.requestId, e.correlationId, e.durationMs, JSON.stringify(e.summary), now());
    return Number(r.lastInsertRowid);
  }

  listEvidence(attemptId: string) {
    return this.db.prepare("SELECT * FROM evidence WHERE attempt_id = ? ORDER BY seq").all(attemptId) as Array<Record<string, unknown>>;
  }

  close() {
    this.db.close();
  }
}
