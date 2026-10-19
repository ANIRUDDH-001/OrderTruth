import { DatabaseSync } from "node:sqlite";

/**
 * Read-only webhook inbox status (counts and a short, PII-free recent-event list). Opens the
 * database read-only, so it can run beside a live listener and can never migrate or write.
 * Output contains no credentials, no webhook id, no payloads, no payer/payee data, no
 * transmission signatures or correlation ids.
 */
export type WebhookStatus = {
  schemaVersion: number;
  summary: { pending: number; verified: number; processed: number; rejected: number; retried: number; failed: number };
  deliveries: { total: number; byState: Record<string, number>; rejectedByReason: Record<string, number>; lastReceivedAt: string | null };
  events: { total: number; byState: Record<string, number>; redelivered: number; multiAttempt: number; oldestPendingAgeSec: number | null };
  ingress: { storedUnverified: number; ceiling: number | null };
  retention: { policy: string; eligibleUnderProposedPolicy: number; protected: number };
  recentEvents: Array<{ eventId: string; type: string; state: string; deliveries: number; processAttempts: number; outcome: string | null }>;
};

/** Proposed (not executed) pruning horizon for noise rows; see docs/GATE1B_LIVE_PREFLIGHT.md. */
export const RETENTION_NOISE_DAYS = 30;

const counts = (db: DatabaseSync, sql: string) => Object.fromEntries((db.prepare(sql).all() as Array<{ k: string; n: number }>).map((r) => [r.k, Number(r.n)]));

export function webhookStatus(dbPath: string, o: { ceiling?: number; nowMs?: number } = {}): WebhookStatus {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const nowMs = o.nowMs ?? Date.now();
    const v = (db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number }).v;
    if (v < 3) throw new Error(`webhook inbox schema not present (schema version ${v}; start the listener once to migrate)`);
    const d = counts(db, "SELECT state AS k, COUNT(*) AS n FROM webhook_deliveries GROUP BY state");
    const e = counts(db, "SELECT state AS k, COUNT(*) AS n FROM webhook_events GROUP BY state");
    const reasons = counts(
      db,
      "SELECT CASE WHEN instr(reason, ':') > 0 THEN substr(reason, 1, instr(reason, ':') - 1) ELSE reason END AS k, COUNT(*) AS n FROM webhook_deliveries WHERE state IN ('rejected', 'retryable_failure', 'abandoned') GROUP BY k",
    );
    const one = (sql: string, ...p: Array<number | string>) => Number((db.prepare(sql).get(...p) as { n: number | null }).n ?? 0);
    const sum = (r: Record<string, number>, ks: string[]) => ks.reduce((a, k) => a + (r[k] ?? 0), 0);
    const last = db.prepare("SELECT MAX(received_at_ms) AS t FROM webhook_deliveries").get() as { t: number | null };
    const oldest = db.prepare("SELECT MIN(d.received_at_ms) AS t FROM webhook_events e JOIN webhook_deliveries d ON d.seq = e.first_delivery_seq WHERE e.state IN ('verified_pending', 'processing', 'retryable_failure')").get() as { t: number | null };
    const horizon = nowMs - RETENTION_NOISE_DAYS * 86_400_000;
    const eligible = one(
      "SELECT COUNT(*) AS n FROM webhook_deliveries d WHERE d.state IN ('rejected', 'abandoned', 'retryable_failure', 'duplicate') AND d.received_at_ms < ? AND NOT EXISTS (SELECT 1 FROM webhook_events e WHERE e.first_delivery_seq = d.seq)",
      horizon,
    );
    const total = one("SELECT COUNT(*) AS n FROM webhook_deliveries");
    const recent = db
      .prepare("SELECT event_id, event_type, state, deliveries, process_attempts, outcome FROM webhook_events ORDER BY first_delivery_seq DESC LIMIT 10")
      .all() as Array<{ event_id: string; event_type: string; state: string; deliveries: number; process_attempts: number; outcome: string | null }>;
    return {
      schemaVersion: v,
      summary: {
        pending: sum(d, ["received_unverified"]) + sum(e, ["verified_pending", "processing", "retryable_failure"]),
        verified: sum(d, ["verified", "duplicate"]),
        processed: sum(e, ["processed"]),
        rejected: sum(d, ["rejected"]),
        retried: sum(d, ["retryable_failure"]) + one("SELECT COUNT(*) AS n FROM webhook_events WHERE process_attempts > 1"),
        failed: sum(e, ["failed", "disagreed"]),
      },
      deliveries: { total, byState: d, rejectedByReason: reasons, lastReceivedAt: last.t ? new Date(last.t).toISOString() : null },
      events: {
        total: one("SELECT COUNT(*) AS n FROM webhook_events"),
        byState: e,
        redelivered: one("SELECT COUNT(*) AS n FROM webhook_events WHERE deliveries > 1"),
        multiAttempt: one("SELECT COUNT(*) AS n FROM webhook_events WHERE process_attempts > 1"),
        oldestPendingAgeSec: oldest.t ? Math.round((nowMs - oldest.t) / 1000) : null,
      },
      ingress: { storedUnverified: sum(d, ["received_unverified", "rejected", "retryable_failure", "abandoned", "duplicate"]), ceiling: o.ceiling ?? null },
      retention: {
        policy: `keep-all (no deletion implemented); proposed: noise deliveries older than ${RETENTION_NOISE_DAYS} d prunable only after backup + explicit approval`,
        eligibleUnderProposedPolicy: eligible,
        protected: total - eligible,
      },
      recentEvents: recent.map((r) => ({ eventId: r.event_id, type: r.event_type, state: r.state, deliveries: Number(r.deliveries), processAttempts: Number(r.process_attempts), outcome: r.outcome })),
    };
  } finally {
    db.close();
  }
}
