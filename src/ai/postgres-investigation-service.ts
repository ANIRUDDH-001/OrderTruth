import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { canonical,sha256 } from "../domain/canonical.ts";
import { withTransaction } from "../db/postgres.ts";
import { PostgresInvestigationStore } from "./postgres-investigation.ts";
import { deterministicInvestigator,type DiagnosticKind,type InvestigationCall,type InvestigationEvidence } from "./investigation.ts";
import { MERCHANT_EGRESS_POLICY } from "./evidence-egress.ts";
import { GROUNDED_POLICY,validateGroundedProjection } from "./grounded-investigation.ts";
import { COMPARISON_POLICY,prepareComparisonContext } from "./comparison-investigation.ts";
import { AGENT_POLICY,isConcluded,prepareAgentContext } from "./agent-investigation.ts";

const snapshotIdentity=(model:string,evidence:readonly InvestigationEvidence[],policy:string=COMPARISON_POLICY)=>sha256(canonical({policy:`investigator-v3:${MERCHANT_EGRESS_POLICY}:${GROUNDED_POLICY}:${policy}`,model,evidence}));

/** Historical advice has its own immutable snapshot. Do not acquire payment
 * writer locks, assemble current evidence or require an enabled provider. */
export async function readInvestigationHistory(pool:Pool,schema:string,user:string,run:string){
  if(schema!=='ordertruth'&&!/^qual_[a-f0-9]{20}$/.test(schema))throw Error('Invalid OrderTruth schema');
  const rows=(await pool.query(`SELECT a.* FROM ${schema}.scenario_runs r LEFT JOIN LATERAL (
    SELECT id,evidence_json,result_json,snapshot_sha256,model,completed_at,usage_json FROM ${schema}.ai_investigations
    WHERE run_id=r.id AND user_id=r.user_id AND status='FRESH' AND evidence_json IS NOT NULL ORDER BY completed_at DESC,id DESC
  ) a ON true WHERE r.id=$1 AND r.user_id=$2 ORDER BY a.completed_at DESC,a.id DESC`,[run,user])).rows;
  if(!rows.length)throw Error('Scenario not found for session');
  for(const row of rows){
  if(!row.id)continue;
  const evidence=JSON.parse(row.evidence_json) as InvestigationEvidence[];
  if(![COMPARISON_POLICY,'merchant-comparison-v1'].some(policy=>row.snapshot_sha256===snapshotIdentity(row.model,evidence,policy)))continue;
  const parsed=validateGroundedProjection(JSON.parse(row.result_json),evidence);
  if(!parsed.ok)continue;
  return {status:'CACHED' as const,freshModelExecution:false,historical:true,reason:null,retryAt:null,evidence,baseline:deterministicInvestigator(evidence),
    snapshotSha256:row.snapshot_sha256 as string,investigation:parsed.result,model:row.model as string,generatedAt:row.completed_at as string,usage:JSON.parse(row.usage_json) as InvestigationCall['usage']};
  }
  return null;
}

/** Autopilot steps for one run, oldest first. Every row is revalidated against
 * its own immutable evidence snapshot; rows that no longer validate are omitted
 * rather than repaired. Reading never reserves allowance or calls a provider. */
export async function readAutopilotTrace(pool:Pool,schema:string,user:string,run:string){
  if(schema!=='ordertruth'&&!/^qual_[a-f0-9]{20}$/.test(schema))throw Error('Invalid OrderTruth schema');
  const rows=(await pool.query(`SELECT a.id,a.evidence_json,a.result_json,a.snapshot_sha256,a.model,a.completed_at,a.usage_json FROM ${schema}.scenario_runs r
    LEFT JOIN ${schema}.ai_investigations a ON a.run_id=r.id AND a.user_id=r.user_id AND a.status='FRESH' AND a.evidence_json IS NOT NULL
    WHERE r.id=$1 AND r.user_id=$2 ORDER BY a.completed_at,a.id`,[run,user])).rows;
  if(!rows.length)throw Error('Scenario not found for session');
  const steps=rows.flatMap(row=>{
    if(!row.id)return [];
    const evidence=JSON.parse(row.evidence_json) as InvestigationEvidence[];
    if(row.snapshot_sha256!==snapshotIdentity(row.model,evidence,AGENT_POLICY))return [];
    const parsed=validateGroundedProjection(JSON.parse(row.result_json),evidence);
    if(!parsed.ok)return [];
    return [{snapshotSha256:row.snapshot_sha256 as string,model:row.model as string,generatedAt:row.completed_at as string,usage:JSON.parse(row.usage_json) as InvestigationCall['usage'],
      evidence,investigation:parsed.result,concluded:isConcluded(parsed.result)}];
  });
  return {policy:AGENT_POLICY,steps,concluded:steps.at(-1)?.concluded??false};
}

type Contract = "comparison" | "agent";
type Settings = { model: string; dailyLimit: number; userDailyLimit: number; minIntervalMs: number;
  infer(evidence: readonly InvestigationEvidence[]): Promise<InvestigationCall>;
  /** Autopilot step inference. Absent means Autopilot is not configured. */
  inferAgent?(evidence: readonly InvestigationEvidence[]): Promise<InvestigationCall> };
/** Atomic application allowance below the user-reported free model entitlement.
 * A reservation is consumed even after provider failure or process termination.
 * No automatic retries, paid fallback, or key rotation. */
export class PostgresInvestigationService {
  private readonly evidenceStore: PostgresInvestigationStore;
  constructor(readonly pool: Pool,readonly schema: string,private readonly settings: Settings) {
    this.evidenceStore = new PostgresInvestigationStore(pool,schema);
    if (!Number.isInteger(settings.dailyLimit) || settings.dailyLimit < 0 || settings.dailyLimit > 200
      || !Number.isInteger(settings.userDailyLimit) || settings.userDailyLimit < 0 || settings.userDailyLimit > 10
      || !Number.isInteger(settings.minIntervalMs) || settings.minIntervalMs < 0 || (process.env.NODE_ENV !== "test" && settings.minIntervalMs < 5000)) throw new Error("Invalid bounded AI allowance");
  }
  private tx<T>(action: (client: PoolClient) => Promise<T>) {
    return withTransaction(this.pool,async client => {
      await client.query("SELECT set_config('search_path',$1,true)", [`${this.schema},pg_catalog`]);
      return action(client);
    });
  }
  async history(user: string,run: string) {
    return readInvestigationHistory(this.pool,this.schema,user,run);
  }
  trace(user: string,run: string) {
    return readAutopilotTrace(this.pool,this.schema,user,run);
  }
  /** One durable Autopilot step: a reserved model choice, then the read-only
   * check it selected. The check is idempotent per run and kind, and a repeated
   * request for an unchanged snapshot is served from the stored choice, so a
   * client may resume after an interrupted response without a second model
   * call. Nothing here can approve, plan or execute a repair. */
  async step(user: string,run: string,network?: string | null) {
    const result = await this.investigate(user,run,network,"agent");
    if (!("investigation" in result)) return { ...result,concluded: false,executed: null };
    if (isConcluded(result.investigation)) return { ...result,concluded: true,executed: null };
    const executed = await this.evidenceStore.diagnostic(user,run,result.investigation.nextDiagnostic as DiagnosticKind);
    return { ...result,concluded: false,executed };
  }
  async investigate(user: string,run: string,network?: string | null,contract: Contract = "comparison") {
    const evidence = await this.evidenceStore.evidence(user,run);
    const baseline = deterministicInvestigator(evidence);
    const policy = contract === "agent" ? AGENT_POLICY : COMPARISON_POLICY;
    const infer = contract === "agent" ? this.settings.inferAgent : this.settings.infer;
    const snapshotSha256 = snapshotIdentity(this.settings.model,evidence,policy);
    const unavailable = (reason: string,retryAt: string | null = null) => ({ status: "UNAVAILABLE" as const,freshModelExecution: false,reason,retryAt,baseline,evidence,snapshotSha256 });
    // Privacy rejection is not an inference reservation or a provider attempt.
    if (!infer) return unavailable("AI_NOT_CONFIGURED");
    try { if(!(contract === "agent" ? prepareAgentContext : prepareComparisonContext)(evidence).choices.length)return unavailable('NO_ACTIONABLE_COMPARISON'); } catch { return unavailable("AI_EGRESS_REJECTED"); }
    const now = Date.now(); const day = new Date(now).toISOString().slice(0,10);
    const nextDay=new Date(Date.parse(`${day}T00:00:00.000Z`)+86_400_000).toISOString();
    const reservation = await this.tx(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${this.schema}:ai-reservation`]);
      // A locked day row arbitrates caches, quota, spacing and one in-flight
      // request across every process. No model request runs in this transaction.
      const opened = await client.query("INSERT INTO ai_budget_days(day) VALUES($1) ON CONFLICT DO NOTHING", [day]);
      if (opened.rowCount === 1) await client.query("DELETE FROM demo_action_budgets WHERE key LIKE 'ai-network:%' AND key NOT LIKE $1",[`ai-network:${day}:%`]);
      const budget = (await client.query("SELECT * FROM ai_budget_days WHERE day=$1 FOR UPDATE", [day])).rows[0];
      await client.query(`UPDATE ai_investigations SET status='UNAVAILABLE',completed_at=$1,error_kind='INTERRUPTED_UNKNOWN_USAGE'
        WHERE status='RESERVED' AND requested_at<$2`, [new Date(now).toISOString(),new Date(now-90_000).toISOString()]);
      const cached = (await client.query(`SELECT * FROM ai_investigations WHERE run_id=$1 AND user_id=$2 AND snapshot_sha256=$3
        AND model=$4 AND status='FRESH' ORDER BY completed_at DESC LIMIT 1`, [run,user,snapshotSha256,this.settings.model])).rows[0];
      if (cached) return { cached };
      // Durable, model-scoped circuit: failed calls keep their reservations.
      // One global RESERVED row below also arbitrates the recovery probe.
      const recent = (await client.query(`SELECT status,error_kind,completed_at FROM ai_investigations
        WHERE model=$1 AND completed_at IS NOT NULL ORDER BY completed_at DESC,id DESC LIMIT 3`,[this.settings.model])).rows;
      const last = recent[0];
      const failures = new Set(["NETWORK","TIMEOUT","PROVIDER_UNAVAILABLE","PROVIDER_FAILURE"]);
      const cooling = last?.error_kind === "QUOTA_OR_RATE_LIMIT" ? 60_000
        : recent.length === 3 && recent.every(r => r.status === "UNAVAILABLE" && failures.has(r.error_kind)) ? 30_000 : 0;
      const reopenAt = last ? Date.parse(last.completed_at)+cooling : 0;
      if (cooling && now < reopenAt) return { reason: "PROVIDER_CIRCUIT_OPEN",retryAt: new Date(reopenAt).toISOString() };
      if (this.settings.dailyLimit === 0 || this.settings.userDailyLimit === 0) return { reason: "BUDGET_DISABLED" };
      if (budget.reservations >= this.settings.dailyLimit) return { reason: "APP_DAILY_BUDGET",retryAt:nextDay };
      const own = (await client.query("SELECT count(*)::integer AS n FROM ai_investigations WHERE user_id=$1 AND requested_at>=$2 AND requested_at<$3", [user,`${day}T00:00:00.000Z`,nextDay])).rows[0].n;
      if (own >= this.settings.userDailyLimit) return { reason: "SESSION_DAILY_BUDGET",retryAt:nextDay };
      if (network === null || (network !== undefined && !network.startsWith(day+":"))) return { reason: "AI_ATTRIBUTION_UNAVAILABLE" };
      const networkBudget = network === undefined ? null : `ai-network:${network}`;
      if (networkBudget) {
        const group = (await client.query("SELECT used FROM demo_action_budgets WHERE key=$1",[networkBudget])).rows[0];
        if (group && group.used >= Math.max(1,Math.floor(this.settings.dailyLimit/2))) return { reason: "NETWORK_DAILY_BUDGET",retryAt:nextDay };
      }
      if ((await client.query("SELECT 1 FROM ai_investigations WHERE status='RESERVED' LIMIT 1")).rowCount) return { reason: "AI_BUSY" };
      if (now-budget.last_reserved_at_ms < this.settings.minIntervalMs) return { reason: "APP_REQUEST_SPACING",retryAt: new Date(budget.last_reserved_at_ms+this.settings.minIntervalMs).toISOString() };
      const id = `ai_${randomUUID()}`;
      await client.query("UPDATE ai_budget_days SET reservations=reservations+1,last_reserved_at_ms=$1 WHERE day=$2", [now,day]);
      if (networkBudget) await client.query(`INSERT INTO demo_action_budgets(key,used) VALUES($1,1)
        ON CONFLICT(key) DO UPDATE SET used=demo_action_budgets.used+1`,[networkBudget]);
      await client.query("INSERT INTO ai_investigations(id,run_id,user_id,snapshot_sha256,status,model,requested_at,evidence_json) VALUES($1,$2,$3,$4,'RESERVED',$5,$6,$7)", [id,run,user,snapshotSha256,this.settings.model,new Date(now).toISOString(),JSON.stringify(evidence)]);
      return { id };
    });
    if ("cached" in reservation && reservation.cached) {
      const cached = reservation.cached;
      const parsed = validateGroundedProjection(JSON.parse(cached.result_json),evidence);
      if (!parsed.ok) return unavailable("CACHED_RESULT_INVALID");
      return { status: "CACHED" as const,freshModelExecution: false,reason: null,retryAt: null,baseline,evidence,snapshotSha256,
        investigation: parsed.result,model: cached.model as string,generatedAt: cached.completed_at as string,usage: JSON.parse(cached.usage_json) as InvestigationCall["usage"] };
    }
    if ("reason" in reservation && reservation.reason) return unavailable(reservation.reason,reservation.retryAt ?? null);
    if (!("id" in reservation) || !reservation.id) return unavailable("RESERVATION_UNAVAILABLE");
    let result: InvestigationCall;
    try { result = await infer(evidence); }
    catch { result = { ok: false,result: null,error: "PROVIDER_FAILURE",usage: { promptTokens: null,outputTokens: null,totalTokens: null },httpStatus: null,latencyMs: 0 }; }
    const validated = result.ok ? validateGroundedProjection(result.result,evidence) : null;
    const ok = validated?.ok === true;
    const failure = result.error ?? (validated && !validated.ok ? validated.error : "INVALID_MODEL_RESULT");
    const completedAt = new Date().toISOString();
    const completion = await this.evidenceStore.withEvidence(user,run,async (current,client)=>{
      const stale=snapshotIdentity(this.settings.model,current,policy)!==snapshotSha256;
      const publish=ok&&!stale;
      const stored=(await client.query(`UPDATE ai_investigations SET status=$1,completed_at=$2,result_json=$3,usage_json=$4,error_kind=$5
        WHERE id=$6 AND status='RESERVED'`,[publish?"FRESH":"UNAVAILABLE",completedAt,publish?JSON.stringify(validated.result):null,JSON.stringify(result.usage),stale?"STALE_EVIDENCE":ok?null:failure,reservation.id])).rowCount===1;
      return {stored,stale};
    });
    if (!completion.stored) return unavailable("RESERVATION_INTERRUPTED");
    if (completion.stale) return unavailable("STALE_EVIDENCE");
    if (!ok) return unavailable(failure);
    return { status: "FRESH" as const,freshModelExecution: true,reason: null,retryAt: null,baseline,evidence,snapshotSha256,
      investigation: validated.result,model: this.settings.model,generatedAt: completedAt,usage: result.usage };
  }
}
