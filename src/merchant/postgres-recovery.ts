import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Outcome, RepairPlan } from "./repair.ts";
import type { AttemptRow, IntentRow } from "../db/store.ts";
import type { IncidentRow, MerchantOrderRow } from "./repo.ts";
import { CONTRACT_ID, INCIDENT_CLASS, evaluateContract, readbackFact, type PaymentFacts } from "./contract.ts";
import { canonical, sha256 } from "../domain/canonical.ts";
import { withTransaction } from "../db/postgres.ts";
import { postgresWebhookProof } from "../db/postgres-webhook-proof.ts";

type Evidence = { seq: number; evidence_class: string; http_status: number | null; created_at: string; summary_json: string };
type EffectiveOrder = MerchantOrderRow & { effective_status: string };
const hashPlan = (plan: RepairPlan): string => { const { plan_sha256: _, ...body } = plan; return sha256(canonical(body)); };
const intactPlan = (plan: RepairPlan): boolean => hashPlan(plan) === plan.plan_sha256 && sha256(plan.facts_json) === plan.facts_sha256;
const printable = (value: string): string => {
  if (!value.trim() || value.length > 100 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid actor identity");
  return value.trim();
};

/** PostgreSQL duplicate-order vertical slice. No provider dependency and no financial actions.
 * Authorization is supplied by the HTTP/session boundary, never by an organization header.
 * Webhook-linked cases require consistent persisted verification/evidence/audit proof. */
export class PostgresRecoveryService {
  constructor(readonly pool: Pool, readonly schema = "ordertruth", private readonly scope?: { runId: string; userId: string }) {
    if (schema !== "ordertruth" && !/^qual_[a-f0-9]{20}$/.test(schema)) throw new Error("Invalid OrderTruth schema");
  }
  private transaction<T>(org: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!/^org_[a-z0-9_]{1,40}$/.test(org)) throw new Error("Invalid organization scope");
    return withTransaction(this.pool, async client => {
      await client.query("SELECT set_config('search_path',$1,true)", [`${this.schema},pg_catalog`]);
      return action(client);
    });
  }
  private async lock(client: PoolClient, org: string, intentId: string) {
    const attempt = (await client.query<AttemptRow>(`SELECT a.* FROM payment_attempts a JOIN checkout_intents i ON i.id=a.intent_id
      WHERE i.id=$1 AND i.organization_id=$2 FOR UPDATE OF a`, [intentId, org])).rows[0];
    if (!attempt) throw new Error("Intent not found for scope");
    await client.query("SELECT id FROM checkout_intents WHERE id=$1 FOR UPDATE", [intentId]);
    if (this.scope) {
      const run = await client.query("SELECT id FROM scenario_runs WHERE id=$1 AND user_id=$2 AND payment_attempt_id=$3 FOR UPDATE", [this.scope.runId,this.scope.userId,attempt.id]);
      if (!run.rowCount) throw new Error("Scenario not found for scope");
    }
  }
  private async incident(client: PoolClient, org: string, id: string): Promise<IncidentRow> {
    const incident = (await client.query<IncidentRow>(`SELECT x.* FROM incidents x LEFT JOIN scenario_run_incidents r ON r.incident_id=x.id
      WHERE x.id=$1 AND x.organization_id=$2 AND r.run_id IS NOT DISTINCT FROM $3::text`, [id, org,this.scope?.runId ?? null])).rows[0];
    if (!incident || incident.incident_class !== INCIDENT_CLASS || incident.contract !== CONTRACT_ID) throw new Error("Eligible incident not found for scope");
    await this.lock(client, org, incident.intent_id);
    await client.query("SELECT id FROM incidents WHERE id=$1 FOR UPDATE", [id]);
    return incident;
  }
  private async getPlan(client: PoolClient, org: string, id: string): Promise<RepairPlan> {
    const p = (await client.query<RepairPlan>(`SELECT p.* FROM repair_plans p LEFT JOIN scenario_run_plans r ON r.plan_id=p.id
      WHERE p.id=$1 AND p.organization_id=$2 AND r.run_id IS NOT DISTINCT FROM $3::text`, [id, org,this.scope?.runId ?? null])).rows[0];
    if (!p) throw new Error("Plan not found for scope");
    if (this.scope && !(await client.query("SELECT 1 FROM scenario_runs WHERE id=$1 AND user_id=$2", [this.scope.runId,this.scope.userId])).rowCount) throw new Error("Scenario not found for scope");
    // Corrupt references must not select or lock another case. The plan itself
    // remains the stable operation identity for a durable refusal and replay.
    if (intactPlan(p)) await this.incident(client, org, p.incident_id);
    await client.query("SELECT id FROM repair_plans WHERE id=$1 FOR UPDATE", [id]);
    return p;
  }
  private async snapshot(client: PoolClient, org: string, intentId: string, incident: IncidentRow | null = null) {
    const intent = (await client.query<IntentRow>("SELECT * FROM checkout_intents WHERE id=$1 AND organization_id=$2", [intentId, org])).rows[0]!;
    const attempt = (await client.query<AttemptRow>("SELECT * FROM payment_attempts WHERE intent_id=$1", [intentId])).rows[0]!;
    const evidence = (await client.query<Evidence>("SELECT * FROM evidence WHERE attempt_id=$1 ORDER BY seq", [attempt.id])).rows;
    const webhook = await postgresWebhookProof(client,attempt);
    const orders = (await client.query<EffectiveOrder>(`SELECT m.*,CASE WHEN v.order_id IS NULL THEN m.status ELSE 'voided_duplicate' END AS effective_status
      FROM merchant_orders m LEFT JOIN merchant_order_voids v ON v.order_id=m.id LEFT JOIN scenario_run_orders r ON r.order_id=m.id
      WHERE m.organization_id=$1 AND m.intent_id=$2 AND r.run_id IS NOT DISTINCT FROM $3::text ORDER BY m.created_at,m.id`, [org, intentId,this.scope?.runId ?? null])).rows;
    const voids = (await client.query(`SELECT v.* FROM merchant_order_voids v JOIN merchant_orders m ON m.id=v.order_id LEFT JOIN scenario_run_orders r ON r.order_id=m.id
      WHERE m.organization_id=$1 AND m.intent_id=$2 AND r.run_id IS NOT DISTINCT FROM $3::text ORDER BY v.order_id`, [org, intentId,this.scope?.runId ?? null])).rows;
    const resolution = incident ? (await client.query("SELECT * FROM incident_resolutions WHERE incident_id=$1", [incident.id])).rows[0] ?? null : null;
    const readbacks = evidence.filter(e => e.evidence_class === "PAYPAL_API_READBACK");
    const payment: PaymentFacts = { intentId, intentSku: intent.sku, intentCurrency: intent.currency, intentMinor: intent.amount_minor,
      attemptId: attempt.id, attemptState: attempt.state, paypalOrderId: attempt.paypal_order_id, captureId: attempt.capture_id,
      captureStatus: attempt.capture_status, capturedMinor: attempt.captured_minor, capturedCurrency: attempt.captured_currency,
      readbacks: readbacks.map(readbackFact) };
    const evaluation = evaluateContract(payment, orders.map(o => ({ id: o.id, status: o.status, effectiveStatus: o.effective_status,
      attemptId: o.attempt_id, paypalOrderId: o.paypal_order_id, captureId: o.capture_id, sku: o.sku, currency: o.currency, amountMinor: o.amount_minor })));
    const providerHash = sha256(canonical({ intent, attempt, evidence, ...(webhook ? { webhook } : {}) }));
    const factsJson = canonical({ contract: CONTRACT_ID, intent, attempt, providerHash, orders, voids, incident, resolution, scenarioRunId: this.scope?.runId ?? null });
    return { intent, attempt, evidence, orders, resolution, evaluation, providerHash, factsJson };
  }
  private eligible(s: Awaited<ReturnType<PostgresRecoveryService["snapshot"]>>) {
    const active = s.orders.filter(o => o.effective_status === "placed");
    if (s.resolution || !s.evaluation.eligible || s.evaluation.result !== "VIOLATED" || active.length < 2 || s.evaluation.matchingOrderIds.length !== active.length) {
      throw new Error("Current facts are not eligible for duplicate repair");
    }
    return active;
  }
  private async evaluation(client: PoolClient, org: string, s: Awaited<ReturnType<PostgresRecoveryService["snapshot"]>>, run: string): Promise<number> {
    const result = await client.query(`INSERT INTO invariant_evaluations(organization_id,contract,intent_id,result,active_order_count,reasons_json,facts_json,run_id,evaluated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING seq`, [org, CONTRACT_ID, s.intent.id, s.evaluation.result, s.evaluation.activeOrderCount,
      canonical(s.evaluation.reasons), canonical({ matchingOrderIds: s.evaluation.matchingOrderIds, confirmingReadbackSeqs: s.evaluation.confirmingReadbackSeqs, repairFacts: JSON.parse(s.factsJson) }), run, new Date().toISOString()]);
    return result.rows[0].seq as number;
  }
  async check(org: string, intent: string): Promise<{ incidentId: string | null; result: string }> {
    return this.transaction(org, async client => {
      await this.lock(client, org, intent);
      const s = await this.snapshot(client, org, intent);
      const seq = await this.evaluation(client, org, s, `check_${randomUUID()}`);
      if (s.evaluation.result !== "VIOLATED") return { incidentId: null, result: s.evaluation.result };
      const active = (await client.query<IncidentRow>(`SELECT x.* FROM incidents x LEFT JOIN incident_resolutions r ON r.incident_id=x.id LEFT JOIN scenario_run_incidents s ON s.incident_id=x.id
        WHERE x.organization_id=$1 AND x.intent_id=$2 AND x.incident_class=$3 AND r.incident_id IS NULL AND s.run_id IS NOT DISTINCT FROM $4::text ORDER BY x.opened_at DESC LIMIT 1`, [org, intent, INCIDENT_CLASS,this.scope?.runId ?? null])).rows[0];
      if (active) return { incidentId: active.id, result: s.evaluation.result };
      const id = `inc_${randomUUID()}`;
      await client.query(`INSERT INTO incidents(id,organization_id,contract,dedup_key,severity,state,intent_id,attempt_id,paypal_order_id,capture_id,title,opened_by_evaluation_seq,reproduction_json,opened_at,incident_class)
        VALUES($1,$2,$3,$4,'high','open',$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id, org, CONTRACT_ID, `${org}|${CONTRACT_ID}|${intent}|${id}`, intent,
        s.attempt.id, s.attempt.paypal_order_id, s.attempt.capture_id, `${s.evaluation.activeOrderCount} merchant orders for one recorded capture`, seq,
        canonical({ cause: "UNKNOWN", note: "Merchant anomaly; provider observations retain their explicit provenance" }), new Date().toISOString(), INCIDENT_CLASS]);
      if (this.scope) await client.query("INSERT INTO scenario_run_incidents(incident_id,run_id) VALUES($1,$2)", [id,this.scope.runId]);
      for (const e of s.evidence.filter(e => s.evaluation.confirmingReadbackSeqs.includes(e.seq))) {
        await client.query("INSERT INTO incident_evidence(incident_id,evidence_class,ref_type,ref_id,source_at,summary_json,linked_at) VALUES($1,'PAYPAL_API_READBACK','evidence',$2,$3,$4,$5)",
          [id, String(e.seq), e.created_at, e.summary_json, new Date().toISOString()]);
      }
      for (const o of s.orders.filter(o => s.evaluation.matchingOrderIds.includes(o.id))) {
        await client.query("INSERT INTO incident_evidence(incident_id,evidence_class,ref_type,ref_id,source_at,summary_json,linked_at) VALUES($1,'MERCHANT_DB_OBSERVED','merchant_order',$2,$3,$4,$5)",
          [id, o.id, o.created_at, canonical({ snapshot: o }), new Date().toISOString()]);
      }
      return { incidentId: id, result: s.evaluation.result };
    });
  }
  async plan(org: string, incidentId: string, actor: string): Promise<RepairPlan> {
    return this.transaction(org, async client => {
      const incident = await this.incident(client, org, incidentId);
      const s = await this.snapshot(client, org, incident.intent_id, incident);
      const active = this.eligible(s);
      if (incident.attempt_id !== s.attempt.id || incident.capture_id !== s.attempt.capture_id || incident.paypal_order_id !== s.attempt.paypal_order_id) throw new Error("Incident payment identity differs");
      const now = Date.now();
      const p: RepairPlan = { id: `rp_${randomUUID()}`, organization_id: org, incident_id: incidentId, intent_id: s.intent.id, contract: CONTRACT_ID,
        evaluation_seq: await this.evaluation(client, org, s, `plan_${randomUUID()}`), keep_order_id: active[0]!.id,
        void_order_ids_json: canonical(active.slice(1).map(o => o.id).sort()), cause_at_plan: incident.reproduction_json,
        facts_json: s.factsJson, facts_sha256: sha256(s.factsJson), plan_sha256: "", requester_name: printable(actor),
        created_at: new Date(now).toISOString(), expires_at: new Date(now + 900_000).toISOString() };
      p.plan_sha256 = hashPlan(p);
      const keys = Object.keys(p) as Array<keyof RepairPlan>;
      await client.query(`INSERT INTO repair_plans(${keys.join(",")}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(",")})`, keys.map(k => p[k]));
      if (this.scope) await client.query("INSERT INTO scenario_run_plans(plan_id,run_id) VALUES($1,$2)", [p.id,this.scope.runId]);
      await this.audit(client, p.id, "PLANNED", { requester: p.requester_name });
      return p;
    });
  }
  private async audit(client: PoolClient, plan: string, event: string, detail: unknown) {
    await client.query("INSERT INTO repair_audit(plan_id,event,detail_json,created_at) VALUES($1,$2,$3,$4)", [plan, event, canonical(detail), new Date().toISOString()]);
  }
  /** Qualification fixture approval only. This is never a public authentication substitute. */
  async approveQualification(org: string, id: string, hash: string): Promise<void> {
    if (process.env.NODE_ENV !== "test") throw new Error("Qualification approval is test-only");
    return this.approve(org,id,hash,false);
  }
  /** Caller constructs run scope from a currently validated server-side session. */
  async approveSession(org: string, id: string, hash: string): Promise<void> {
    if (!this.scope) throw new Error("Session approval requires an owned scenario");
    return this.approve(org,id,hash,true);
  }
  private async approve(org: string, id: string, hash: string, browser: boolean): Promise<void> {
    return this.transaction(org, async client => {
      const p = await this.getPlan(client, org, id);
      if (hashPlan(p) !== hash || hash !== p.plan_sha256) throw new Error("Exact plan hash required");
      const previous = (await client.query("SELECT * FROM repair_approvals WHERE plan_id=$1", [id])).rows[0];
      if (previous) {
        if (previous.plan_sha256 === hash && (browser ? previous.approval_mode === "BROWSER_SESSION" && previous.session_user_id === this.scope!.userId : previous.approval_mode === "SIMULATED_TEST")) return;
        throw new Error("Exact plan hash or approval identity differs");
      }
      if (Date.now() >= Date.parse(p.expires_at)) throw new Error("Plan expired");
      const incident = await this.incident(client, org, p.incident_id);
      const s = await this.snapshot(client, org, incident.intent_id, incident);
      this.eligible(s);
      if (sha256(s.factsJson) !== p.facts_sha256) throw new Error("Plan is stale");
      await client.query("INSERT INTO repair_approvals(id,plan_id,plan_sha256,operator_name,identity_assurance,approval_mode,approved_at,session_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [`ra_${randomUUID()}`, id, hash, browser ? this.scope!.userId : "qualification-actor",browser ? "SESSION_AUTHENTICATED" : "LOCAL_DEMO_DECLARED_OPERATOR",browser ? "BROWSER_SESSION" : "SIMULATED_TEST",new Date().toISOString(),browser ? this.scope!.userId : null]);
      await this.audit(client, id, "APPROVED", { mode: browser ? "BROWSER_SESSION" : "SIMULATED_TEST", authentication: browser ? "MAINTAINED_SESSION" : "NONE" });
    });
  }
  async execute(org: string, id: string): Promise<Outcome> {
    return this.transaction(org, async client => {
      const p = await this.getPlan(client, org, id);
      const previous = (await client.query<Outcome>("SELECT o.* FROM repair_outcomes o JOIN repair_executions e ON e.id=o.execution_id WHERE e.plan_id=$1", [id])).rows[0];
      if (previous) return previous;
      if (!intactPlan(p)) {
        // One SQL snapshot, scoped by authenticated organization, without using
        // the untrusted incident/intent references or changing provider state.
        const graph = (await client.query(`SELECT jsonb_build_object(
          'intents',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM checkout_intents i WHERE i.organization_id=$1),'[]'::jsonb),
          'attempts',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM payment_attempts a JOIN checkout_intents i ON i.id=a.intent_id WHERE i.organization_id=$1),'[]'::jsonb),
          'evidence',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.seq) FROM evidence e JOIN payment_attempts a ON a.id=e.attempt_id JOIN checkout_intents i ON i.id=a.intent_id WHERE i.organization_id=$1),'[]'::jsonb)
          ) AS graph`, [org])).rows[0].graph;
        const providerHash = sha256(canonical(graph));
        const execution = `rx_${randomUUID()}`;
        await client.query("INSERT INTO repair_executions(id,plan_id,started_at) VALUES($1,$2,$3)", [execution, id, new Date().toISOString()]);
        await client.query("INSERT INTO repair_transitions VALUES($1,'EXECUTING',$2)", [execution, new Date().toISOString()]);
        const refusal: Outcome = { execution_id: execution, outcome: "REJECTED_INTEGRITY",
          reasons_json: canonical(["Plan integrity failed; provider hashes cover organization scope because plan references are untrusted"]),
          provider_before_sha256: providerHash, provider_after_sha256: providerHash, completed_at: new Date().toISOString() };
        await client.query("INSERT INTO repair_outcomes VALUES($1,$2,$3,$4,$5,$6)", Object.values(refusal));
        await this.audit(client, id, refusal.outcome, { executionId: execution });
        return refusal;
      }
      const incident = await this.incident(client, org, p.incident_id);
      const before = await this.snapshot(client, org, incident.intent_id, incident);
      const execution = `rx_${randomUUID()}`;
      await client.query("INSERT INTO repair_executions(id,plan_id,started_at) VALUES($1,$2,$3)", [execution, p.id, new Date().toISOString()]);
      await client.query("INSERT INTO repair_transitions VALUES($1,'EXECUTING',$2)", [execution, new Date().toISOString()]);
      const approval = (await client.query("SELECT * FROM repair_approvals WHERE plan_id=$1", [id])).rows[0];
      let outcome: Outcome["outcome"] = "SUCCEEDED";
      const browserApproval = approval?.approval_mode === "BROWSER_SESSION" && approval.identity_assurance === "SESSION_AUTHENTICATED"
        && !!this.scope && approval.session_user_id === this.scope.userId && approval.operator_name === this.scope.userId;
      const declaredApproval = !this.scope && approval && ["INTERACTIVE_TTY", "SIMULATED_TEST"].includes(approval.approval_mode) && approval.identity_assurance === "LOCAL_DEMO_DECLARED_OPERATOR";
      if (!approval || approval.plan_sha256 !== p.plan_sha256 || !(browserApproval || declaredApproval)
        || !Number.isFinite(Date.parse(approval.approved_at)) || Date.parse(approval.approved_at) > Date.now()
        || approval.approved_at < p.created_at || approval.approved_at >= p.expires_at) outcome = "REJECTED_APPROVAL";
      if (outcome === "SUCCEEDED" && (Date.now() < Date.parse(p.created_at) || Date.now() >= Date.parse(p.expires_at))) outcome = "REJECTED_EXPIRED";
      if (outcome === "SUCCEEDED") {
        try {
          const active = this.eligible(before);
          if (p.facts_json !== before.factsJson || p.facts_sha256 !== sha256(before.factsJson) || active[0]!.id !== p.keep_order_id
            || canonical(active.slice(1).map(o => o.id).sort()) !== p.void_order_ids_json) throw new Error("Changed facts");
        } catch { outcome = "REJECTED_STALE"; }
      }
      if (outcome === "SUCCEEDED") {
        await client.query("SAVEPOINT correction");
        try {
          for (const order of JSON.parse(p.void_order_ids_json) as string[]) {
            await client.query("INSERT INTO merchant_order_voids VALUES($1,$2,'DUPLICATE_MERCHANT_ORDER',$3)", [order, execution, new Date().toISOString()]);
          }
          const after = await this.snapshot(client, org, incident.intent_id, incident);
          if (after.evaluation.result !== "HOLDS" || after.evaluation.activeOrderCount !== 1 || canonical(after.evaluation.matchingOrderIds) !== canonical([p.keep_order_id]) || after.providerHash !== before.providerHash) throw new Error("Failed postcondition");
          const evaluation = await this.evaluation(client, org, after, execution);
          await client.query("INSERT INTO incident_resolutions VALUES($1,$2,$3,$4)", [incident.id, evaluation, execution, new Date().toISOString()]);
          await client.query("RELEASE SAVEPOINT correction");
        } catch {
          await client.query("ROLLBACK TO SAVEPOINT correction; RELEASE SAVEPOINT correction");
          outcome = "FAILED_POSTCONDITION";
        }
      }
      const after = await this.snapshot(client, org, incident.intent_id, incident);
      const result: Outcome = { execution_id: execution, outcome, reasons_json: canonical(outcome === "SUCCEEDED" ? [] : [outcome]),
        provider_before_sha256: before.providerHash, provider_after_sha256: after.providerHash, completed_at: new Date().toISOString() };
      await client.query("INSERT INTO repair_outcomes VALUES($1,$2,$3,$4,$5,$6)", Object.values(result));
      await this.audit(client, id, outcome, { executionId: execution });
      return result;
    });
  }
  async outcome(org: string, id: string): Promise<Outcome | null> {
    return this.transaction(org, async client => {
      await this.getPlan(client, org, id);
      return (await client.query<Outcome>("SELECT o.* FROM repair_outcomes o JOIN repair_executions e ON e.id=o.execution_id WHERE e.plan_id=$1", [id])).rows[0] ?? null;
    });
  }
  /** A separate SQL check of committed merchant state, not the detector's verdict. */
  async verify(org: string, id: string) {
    return this.transaction(org, async client => {
      const p = await this.getPlan(client, org, id);
      if (!intactPlan(p)) throw new Error("Plan integrity failed; retrieve the terminal refusal instead");
      const receipt = (await client.query<Outcome>("SELECT o.* FROM repair_outcomes o JOIN repair_executions e ON e.id=o.execution_id WHERE e.plan_id=$1", [id])).rows[0];
      if (!receipt) throw new Error("Receipt not found for scope");
      const count = (await client.query(`SELECT count(*)::integer AS active,
        count(*) FILTER(WHERE m.id=$3 AND m.attempt_id=a.id AND m.paypal_order_id=a.paypal_order_id AND m.capture_id=a.capture_id
          AND m.sku=i.sku AND m.amount_minor=i.amount_minor AND m.currency=i.currency)::integer AS keeper
        FROM merchant_orders m JOIN checkout_intents i ON i.id=m.intent_id JOIN payment_attempts a ON a.intent_id=i.id
        LEFT JOIN merchant_order_voids v ON v.order_id=m.id
        LEFT JOIN scenario_run_orders r ON r.order_id=m.id
        WHERE m.organization_id=$1 AND m.intent_id=$2 AND m.status='placed' AND v.order_id IS NULL AND r.run_id IS NOT DISTINCT FROM $4::text`, [org, p.intent_id, p.keep_order_id,this.scope?.runId ?? null])).rows[0];
      const intent = (await client.query("SELECT * FROM checkout_intents WHERE id=$1", [p.intent_id])).rows[0];
      const attempt = (await client.query("SELECT * FROM payment_attempts WHERE intent_id=$1", [p.intent_id])).rows[0];
      const evidence = (await client.query("SELECT * FROM evidence WHERE attempt_id=$1 ORDER BY seq", [attempt.id])).rows;
      const webhook = await postgresWebhookProof(client,attempt as AttemptRow);
      const providerUnchanged = sha256(canonical({ intent, attempt, evidence, ...(webhook ? { webhook } : {}) })) === receipt.provider_after_sha256;
      return { receipt, current: { activeOrders: count.active as number, matchingKeeper: count.keeper as number, providerUnchanged },
        verifiedCurrent: receipt.outcome === "SUCCEEDED" && count.active === 1 && count.keeper === 1 && providerUnchanged };
    });
  }
}
