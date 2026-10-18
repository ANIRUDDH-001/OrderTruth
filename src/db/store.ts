import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AttemptState } from "../domain/checkout.ts";

/**
 * SQLite persistence via Node's built-in `node:sqlite` (ADR-004). All access goes through
 * this module so a later swap (better-sqlite3 / Postgres) touches one file.
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
];

export type IntentRow = { id: string; sku: string; currency: "USD"; amount_minor: number; correlation_id: string; created_at: string };
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
  created_at: string;
  updated_at: string;
};
export type EvidenceInput = {
  attemptId: string | null;
  evidenceClass: "PAYPAL_API_READBACK" | "PAYPAL_API_RESPONSE" | "MERCHANT_DB_OBSERVED" | "CONTROLLED_FAULT_INJECTION" | "AI_HYPOTHESIS";
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

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.#migrate();
  }

  #migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const row = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
    for (let v = row.v; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, now());
      });
    }
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

  createIntentWithAttempt(intent: Omit<IntentRow, "created_at">, attempt: { id: string; createRequestId: string; captureRequestId: string }) {
    const ts = now();
    this.tx(() => {
      this.db
        .prepare("INSERT INTO checkout_intents (id, sku, currency, amount_minor, correlation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(intent.id, intent.sku, intent.currency, intent.amount_minor, intent.correlation_id, ts);
      this.db
        .prepare(
          "INSERT INTO payment_attempts (id, intent_id, create_request_id, capture_request_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'created', ?, ?)",
        )
        .run(attempt.id, intent.id, attempt.createRequestId, attempt.captureRequestId, ts, ts);
    });
  }

  updateAttempt(id: string, patch: Partial<Omit<AttemptRow, "id" | "intent_id" | "created_at" | "updated_at">>) {
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    if (keys.length === 0) return;
    const allowed = new Set([
      "paypal_order_id", "state", "provider_order_status", "capture_id", "capture_status", "captured_minor", "captured_currency",
      "payee_merchant_masked", "verdict_reasons", "create_request_id", "capture_request_id",
    ]);
    for (const k of keys) if (!allowed.has(k)) throw new Error(`illegal column ${String(k)}`);
    const sql = `UPDATE payment_attempts SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => (patch[k] ?? null) as string | number | null), now(), id);
  }

  /** Compare-and-set claim so only one caller can move an attempt into capture_in_progress. */
  claimCapture(id: string, fromStates: readonly AttemptState[]): boolean {
    const placeholders = fromStates.map(() => "?").join(", ");
    const r = this.db
      .prepare(`UPDATE payment_attempts SET state = 'capture_in_progress', updated_at = ? WHERE id = ? AND state IN (${placeholders})`)
      .run(now(), id, ...fromStates);
    return Number(r.changes) === 1;
  }

  getAttemptByOrderId(orderId: string): AttemptRow | undefined {
    return this.db.prepare("SELECT * FROM payment_attempts WHERE paypal_order_id = ?").get(orderId) as AttemptRow | undefined;
  }

  getAttempt(id: string): AttemptRow | undefined {
    return this.db.prepare("SELECT * FROM payment_attempts WHERE id = ?").get(id) as AttemptRow | undefined;
  }

  getIntent(id: string): IntentRow | undefined {
    return this.db.prepare("SELECT * FROM checkout_intents WHERE id = ?").get(id) as IntentRow | undefined;
  }

  listAttempts(): AttemptRow[] {
    return this.db.prepare("SELECT * FROM payment_attempts ORDER BY created_at").all() as AttemptRow[];
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
