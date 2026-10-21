import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { withTransaction } from "../db/postgres.ts";
import { sha256 } from "../domain/canonical.ts";
import { diagnosticKinds,type DiagnosticKind,type InvestigationEvidence } from "./investigation.ts";

type Run = { id: string; payment_attempt_id: string; source_evidence_seq: number; provenance: string; created_at: string };
type Handler = { handler: string; idempotency_key: string; started_at: string; finished_at: string; merchant_order_id: string };
export class PostgresInvestigationStore {
  constructor(readonly pool: Pool,readonly schema = "ordertruth") {
    if (schema !== "ordertruth" && !/^qual_[a-f0-9]{20}$/.test(schema)) throw new Error("Invalid OrderTruth schema");
  }
  private tx<T>(action: (client: PoolClient) => Promise<T>) {
    return withTransaction(this.pool,async client => {
      await client.query("SELECT set_config('search_path',$1,true)", [`${this.schema},pg_catalog`]);
      return action(client);
    });
  }
  private async owned(client: PoolClient,user: string,id: string) {
    const run = (await client.query<Run>("SELECT * FROM scenario_runs WHERE id=$1 AND user_id=$2", [id,user])).rows[0];
    if (!run) throw new Error("Scenario not found for session");
    const attempt = (await client.query("SELECT intent_id FROM payment_attempts WHERE id=$1 FOR UPDATE", [run.payment_attempt_id])).rows[0];
    await client.query("SELECT id FROM checkout_intents WHERE id=$1 FOR UPDATE", [attempt.intent_id]);
    await client.query("SELECT id FROM scenario_runs WHERE id=$1 FOR UPDATE", [id]);
    return run;
  }
  async evidence(user: string,id: string): Promise<InvestigationEvidence[]> {
    return this.tx(async client => {
      const run = await this.owned(client,user,id);
      const source = (await client.query("SELECT summary_json,created_at FROM evidence WHERE seq=$1", [run.source_evidence_seq])).rows[0];
      const summary = JSON.parse(source.summary_json) as { status?: string; purchase_units?: Array<{ amount?: unknown; captures?: Array<{ status?: string; amount?: unknown }> }> };
      const orders = (await client.query(`SELECT m.id,m.created_at,v.created_at AS voided_at,m.amount_minor,m.currency,
        CASE WHEN v.order_id IS NULL THEN m.status ELSE 'voided_duplicate' END AS effective_status
        FROM scenario_run_orders s JOIN merchant_orders m ON m.id=s.order_id LEFT JOIN merchant_order_voids v ON v.order_id=m.id WHERE s.run_id=$1 ORDER BY m.created_at,m.id`, [id])).rows;
      const rows = (await client.query("SELECT * FROM scenario_diagnostics WHERE run_id=$1 ORDER BY created_at,id", [id])).rows;
      const recordedAt = orders.reduce((latest: string,row) => [latest,row.created_at as string,(row.voided_at as string | null) ?? latest].sort().at(-1)!,run.created_at);
      return [
        { id: `E${run.source_evidence_seq}`,source: run.provenance === "PAYPAL_SANDBOX_GET" ? "PAYPAL_SANDBOX_OBSERVATION" : "SYNTHETIC_PAYMENT_OBSERVATION",observedAt: source.created_at as string,
          facts: { orderStatus: summary.status,purchaseUnits: summary.purchase_units?.map(u => ({ amount: u.amount,captures: u.captures?.map(c => ({ status: c.status,amount: c.amount })) })) } },
        { id: `M_${run.id}`,source: "CONTROLLED_MERCHANT_STATE",observedAt: recordedAt,
          facts: { activeOrders: orders.filter(o => o.effective_status === "placed").length,orders: orders.map(o => ({ id: o.id,status: o.effective_status,amountMinor: o.amount_minor,currency: o.currency })),providerMutation: false } },
        ...rows.map(row => ({ id: row.id as string,source: "MERCHANT_DIAGNOSTIC" as const,observedAt: row.created_at as string,facts: JSON.parse(row.facts_json) as Record<string,unknown> })),
      ];
    });
  }
  async diagnostic(user: string,id: string,kind: DiagnosticKind): Promise<InvestigationEvidence> {
    if (!diagnosticKinds.includes(kind)) throw new Error("Diagnostic not implemented");
    return this.tx(async client => {
      await this.owned(client,user,id);
      const existing = (await client.query("SELECT * FROM scenario_diagnostics WHERE run_id=$1 AND kind=$2", [id,kind])).rows[0];
      if (existing) return { id: existing.id as string,source: "MERCHANT_DIAGNOSTIC",observedAt: existing.created_at as string,facts: JSON.parse(existing.facts_json) as Record<string,unknown> };
      const handlers = (await client.query<Handler>("SELECT * FROM scenario_handler_attempts WHERE run_id=$1 ORDER BY started_at,id", [id])).rows;
      let facts: Record<string,unknown>;
      if (kind === "IDEMPOTENCY_KEYS") facts = { diagnostic: kind,distinctKeys: new Set(handlers.map(h => h.idempotency_key)).size,
        entries: handlers.map(h => ({ handler: h.handler,keySha256: sha256(h.idempotency_key),merchantOrderId: h.merchant_order_id })),scope: "CONTROLLED_MERCHANT_HANDLERS" };
      else if (kind === "HANDLER_TIMING") facts = { diagnostic: kind,clockPrecision: "MILLISECOND",entries: handlers.map(h => ({ handler: h.handler,startedAt: h.started_at,finishedAt: h.finished_at,
        durationMs: Date.parse(h.finished_at)-Date.parse(h.started_at),merchantOrderId: h.merchant_order_id })),note: "Recorded intervals describe controlled handlers; they do not establish PayPal concurrency." };
      else facts = { diagnostic: kind,committedWrites: handlers.length,entries: handlers.map(h => ({ handler: h.handler,merchantOrderId: h.merchant_order_id,outcome: "COMMITTED" })),
        limitation: "Only committed controlled merchant writes are observed here; absence of a row does not prove no failed attempt occurred." };
      const evidence: InvestigationEvidence = { id: `D_${randomUUID()}`,source: "MERCHANT_DIAGNOSTIC",observedAt: new Date().toISOString(),facts };
      await client.query("INSERT INTO scenario_diagnostics(id,run_id,kind,facts_json,created_at) VALUES($1,$2,$3,$4,$5)", [evidence.id,id,kind,JSON.stringify(facts),evidence.observedAt]);
      return evidence;
    });
  }
}
