import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/postgres.ts";
import type { AttemptRow, IntentRow } from "../db/store.ts";
import { evaluateContract, readbackFact } from "./contract.ts";
import { recordedCapture } from "./recorded-capture.ts";

type Run = { id: string; user_id: string; payment_attempt_id: string; source_evidence_seq: number; provenance: string; label: string; created_at: string };
type ScopedIntent = IntentRow & { organization_id: string };
export type ScenarioKind='DUPLICATE'|'MISSING';
export const validScenarioOperation = (key: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key);
export class ScenarioCreationRejection extends Error {
  constructor(readonly code: "SOURCE_UNAVAILABLE" | "SCENARIO_CAPACITY" | 'OPERATION_KIND_MISMATCH') { super(code === 'OPERATION_KIND_MISMATCH'?'Operation identity differs from the existing case':code === "SCENARIO_CAPACITY" ? "Scenario admission limit reached" : "Scenario requires a genuine Sandbox payment observation"); }
}
export class PostgresScenarioStore {
  constructor(readonly pool: Pool, readonly schema = "ordertruth", private readonly admission = { global: 1000, perUser: 10, leaseMs: 3_600_000 }) {
    if (schema !== "ordertruth" && !/^qual_[a-f0-9]{20}$/.test(schema)) throw new Error("Invalid OrderTruth schema");
    if (!Number.isInteger(admission.global) || admission.global < 1 || admission.global > 1000
      || !Number.isInteger(admission.perUser) || admission.perUser < 1 || admission.perUser > 10
      || !Number.isInteger(admission.leaseMs) || admission.leaseMs < 1 || admission.leaseMs > 3_600_000) throw new Error("Invalid scenario admission policy");
  }
  private tx<T>(action: (client: PoolClient) => Promise<T>) {
    return withTransaction(this.pool, async client => {
      await client.query("SELECT set_config('search_path',$1,true)", [`${this.schema},pg_catalog`]);
      return action(client);
    });
  }
  private async payment(client: PoolClient, id: string, creating = false) {
    const a = (await client.query<AttemptRow>("SELECT * FROM payment_attempts WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!a) { if (creating) throw new ScenarioCreationRejection("SOURCE_UNAVAILABLE"); throw new Error("Payment not found"); }
    const i = (await client.query<ScopedIntent>("SELECT * FROM checkout_intents WHERE id=$1 FOR UPDATE", [a.intent_id])).rows[0]!;
    return { a, i };
  }
  async create(user: string, attempt: string, operationId: string = randomUUID(),kind:ScenarioKind='DUPLICATE'): Promise<Run> { return this.createRun(user, attempt, false, operationId,kind); }
  async createQualification(user: string, attempt: string, operationId: string = randomUUID(),kind:ScenarioKind='DUPLICATE'): Promise<Run> {
    if (process.env.NODE_ENV !== "test") throw new Error("Synthetic scenarios are test-only");
    return this.createRun(user, attempt, true, operationId,kind);
  }
  async lookupOperation(user: string, operationId: string,expectedKind?:ScenarioKind) {
    if (!validScenarioOperation(operationId)) throw new Error("Invalid operation identity");
    const mapped = (await this.pool.query(`SELECT run_id FROM ${this.schema}.scenario_operations WHERE user_id=$1 AND operation_id=$2`, [user,operationId])).rows[0];
    // An absent row is deliberately UNKNOWN: another transaction may commit later.
    const found=mapped?await this.get(user,mapped.run_id as string):null;
    if(found&&expectedKind&&found.caseKind!==expectedKind)throw new ScenarioCreationRejection('OPERATION_KIND_MISMATCH');
    return found;
  }
  private async createRun(user: string, attempt: string, synthetic: boolean, operationId: string,kind:ScenarioKind): Promise<Run> {
    if (!validScenarioOperation(operationId)) throw new Error("Invalid operation identity");
    if(!['DUPLICATE','MISSING'].includes(kind))throw Error('Invalid scenario kind');
    return this.tx(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([this.schema,"scenario-operation",user,operationId])]);
      const existing = (await client.query<Run>(`SELECT r.* FROM scenario_operations o JOIN scenario_runs r ON r.id=o.run_id
        WHERE o.user_id=$1 AND o.operation_id=$2`, [user,operationId])).rows[0];
      if (existing){
        const count=(await client.query('SELECT count(*)::int n FROM scenario_run_orders WHERE run_id=$1',[existing.id])).rows[0].n;
        if((count===0?'MISSING':'DUPLICATE')!==kind)throw new ScenarioCreationRejection('OPERATION_KIND_MISMATCH');
        return existing;
      }
      if (!attempt) throw new ScenarioCreationRejection("SOURCE_UNAVAILABLE");
      const { a, i } = await this.payment(client, attempt, true);
      const provenance = synthetic ? "SYNTHETIC_QUALIFICATION" : "PAYPAL_SANDBOX_GET";
      const source = (await client.query<{ seq: number; http_status: number; created_at: string; summary_json: string }>(`SELECT * FROM evidence
        WHERE attempt_id=$1 AND evidence_class='PAYPAL_API_READBACK' AND http_status=200 AND summary_json::jsonb->>'provenance'=$2 ORDER BY seq DESC LIMIT 1`, [attempt,provenance])).rows[0];
      if (!source) throw new ScenarioCreationRejection("SOURCE_UNAVAILABLE");
      const evaluated = evaluateContract({ intentId: i.id,intentSku: i.sku,intentCurrency: i.currency,intentMinor: i.amount_minor,
        attemptId: a.id,attemptState: a.state,paypalOrderId: a.paypal_order_id,captureId: a.capture_id,captureStatus: a.capture_status,capturedMinor: a.captured_minor,capturedCurrency: a.captured_currency,
        readbacks: [readbackFact(source)] }, []);
      if (!evaluated.eligible) throw new ScenarioCreationRejection("SOURCE_UNAVAILABLE");
      // One bounded admission lock prevents concurrent requests exceeding limits.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${this.schema}:scenario-admission`]);
      const counts = (await client.query(`SELECT count(*)::integer AS total,count(*) FILTER(WHERE r.user_id=$1)::integer AS own
        FROM scenario_admissions a JOIN scenario_runs r ON r.id=a.run_id WHERE a.expires_at>clock_timestamp()`, [user])).rows[0];
      if (counts.total >= this.admission.global || counts.own >= this.admission.perUser) throw new ScenarioCreationRejection("SCENARIO_CAPACITY");
      const run: Run = { id: `run_${randomUUID()}`,user_id: user,payment_attempt_id: attempt,source_evidence_seq: source.seq,provenance,label: "CONTROLLED_MERCHANT_SCENARIO",created_at: new Date().toISOString() };
      await client.query("INSERT INTO scenario_runs VALUES($1,$2,$3,$4,$5,$6,$7)", Object.values(run));
      if(kind==='DUPLICATE')await this.order(client, run, a, i, false);
      await client.query("INSERT INTO scenario_operations(user_id,operation_id,run_id) VALUES($1,$2,$3)", [user,operationId,run.id]);
      await client.query("INSERT INTO scenario_admissions(run_id,expires_at) VALUES($1,clock_timestamp()+$2*interval '1 millisecond')", [run.id,this.admission.leaseMs]);
      return run;
    });
  }
  private async owned(client: PoolClient, user: string, id: string) {
    const run = (await client.query<Run>("SELECT * FROM scenario_runs WHERE id=$1 AND user_id=$2", [id,user])).rows[0];
    if (!run) throw new Error("Scenario not found for session");
    const payment = await this.payment(client, run.payment_attempt_id);
    await client.query("SELECT id FROM scenario_runs WHERE id=$1 FOR UPDATE", [id]);
    return { run, ...payment };
  }
  private async order(client: PoolClient, run: Run, a: AttemptRow, i: ScopedIntent, duplicate: boolean) {
    const id = `mo_${randomUUID()}`; const at = new Date().toISOString();
    const handler = duplicate ? "webhook_capture_completed" : "capture_return";
    // These are real keys used by the controlled merchant's deduplication claim,
    // not invented PayPal event IDs. Different handler namespaces expose the flaw.
    const claimed = await client.query(`INSERT INTO scenario_handler_attempts(id,run_id,handler,idempotency_key,started_at,merchant_order_id)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(run_id,idempotency_key) DO NOTHING RETURNING id`,
      [`handler_${randomUUID()}`,run.id,handler,`${duplicate ? "webhook" : "checkout"}:${run.id}`,at,id]);
    if (!claimed.rowCount) return;
    await client.query(`INSERT INTO merchant_orders(id,organization_id,intent_id,attempt_id,paypal_order_id,capture_id,sku,currency,amount_minor,status,created_by_path,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'placed',$10,$11)`, [id,i.organization_id,i.id,a.id,a.paypal_order_id,a.capture_id,i.sku,i.currency,i.amount_minor,handler,at]);
    await client.query("INSERT INTO scenario_run_orders(order_id,run_id) VALUES($1,$2)", [id,run.id]);
    await client.query("UPDATE scenario_handler_attempts SET finished_at=$1 WHERE id=$2", [new Date().toISOString(),claimed.rows[0].id]);
    // This is merchant scenario evidence, never a new payment/provider observation.
    await client.query(`INSERT INTO evidence(attempt_id,evidence_class,operation,correlation_id,summary_json,created_at)
      VALUES(NULL,'CONTROLLED_FAULT_INJECTION','scenario_merchant_write',$1,$2,$3)`, [run.id,JSON.stringify({ label: run.label,runId: run.id,merchantOrderId: id,sourceEvidenceSeq: run.source_evidence_seq,action: duplicate ? "CONTROLLED_DUPLICATE_WRITE" : "CONTROLLED_BASELINE_WRITE",providerMutation: false }),at]);
  }
  async injectDuplicate(user: string, id: string): Promise<void> {
    return this.tx(async client => {
      const { run, a, i } = await this.owned(client,user,id);
      const count = (await client.query("SELECT count(*)::integer AS n FROM scenario_run_orders WHERE run_id=$1", [id])).rows[0].n;
      if(count===0)throw Error('Missing-order inspection is read-only; not eligible for duplicate injection without a baseline order');
      if (count < 2) await this.order(client,run,a,i,true);
    });
  }
  async get(user: string, id: string) {
    return this.tx(async client => {
      const { run, i } = await this.owned(client,user,id);
      const orders = (await client.query(`SELECT m.*,CASE WHEN v.order_id IS NULL THEN m.status ELSE 'voided_duplicate' END AS effective_status
        FROM scenario_run_orders s JOIN merchant_orders m ON m.id=s.order_id LEFT JOIN merchant_order_voids v ON v.order_id=m.id WHERE s.run_id=$1 ORDER BY m.created_at,m.id`, [id])).rows;
      const source = (await client.query(`SELECT e.created_at,e.http_status,e.evidence_class,e.summary_json,a.paypal_order_id
        FROM evidence e JOIN payment_attempts a ON a.id=e.attempt_id WHERE e.seq=$1 AND e.attempt_id=$2`, [run.source_evidence_seq,run.payment_attempt_id])).rows[0];
      const latestPlan = (await client.query(`SELECT p.id,p.plan_sha256,p.keep_order_id,p.void_order_ids_json,p.expires_at,
        EXISTS(SELECT 1 FROM repair_approvals a WHERE a.plan_id=p.id) AS approved,
        EXISTS(SELECT 1 FROM repair_executions e JOIN repair_outcomes o ON o.execution_id=e.id WHERE e.plan_id=p.id) AS has_receipt
        FROM repair_plans p JOIN scenario_run_plans r ON r.plan_id=p.id WHERE r.run_id=$1 ORDER BY p.created_at DESC,p.id DESC LIMIT 1`, [id])).rows[0] ?? null;
      const latestCheck = (await client.query(`SELECT e.seq,e.result,e.active_order_count AS "activeOrderCount",e.evaluated_at AS "evaluatedAt",e.facts_json::jsonb->'missingOrder' AS "missingOrder",
        (SELECT x.incident_class FROM scenario_run_incidents r JOIN incidents x ON x.id=r.incident_id WHERE r.run_id=$1 AND x.opened_by_evaluation_seq<=e.seq ORDER BY x.opened_at DESC,x.id DESC LIMIT 1) AS "incidentClass",
        (SELECT x.id FROM scenario_run_incidents r JOIN incidents x ON x.id=r.incident_id
          WHERE r.run_id=$1 AND x.opened_by_evaluation_seq<=e.seq ORDER BY x.opened_at DESC,x.id DESC LIMIT 1) AS "incidentId"
        FROM invariant_evaluations e WHERE e.intent_id=$2 AND left(e.run_id,6)='check_'
          AND e.facts_json::jsonb->'repairFacts'->>'scenarioRunId'=$1 ORDER BY e.seq DESC LIMIT 1`, [id,i.id])).rows[0] ?? null;
      if (latestCheck && latestCheck.result !== "VIOLATED") latestCheck.incidentId = null;
      const diagnostics=(await client.query("SELECT id,kind,facts_json,created_at FROM scenario_diagnostics WHERE run_id=$1 ORDER BY created_at,id",[id])).rows.map(row=>({
        id:row.id as string,source:'MERCHANT_DIAGNOSTIC' as const,observedAt:row.created_at as string,facts:JSON.parse(row.facts_json) as Record<string,unknown>,
      }));
      return { run, orders, organizationId: i.organization_id, intentId: i.id,
        latestPlan,latestCheck,diagnostics,caseKind:orders.length===0?'MISSING' as const:'DUPLICATE' as const,
        paymentReference: { attemptId: run.payment_attempt_id,evidenceSeq: run.source_evidence_seq,observedAt: source.created_at as string,provenance: run.provenance,
          recordedCapture:run.provenance==="PAYPAL_SANDBOX_GET" ? recordedCapture(source,source.paypal_order_id) : null,
          note: "Original payment observation; this run changes only controlled merchant state. No payment is cloned or modified." } };
    });
  }
}
