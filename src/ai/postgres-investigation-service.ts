import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { canonical,sha256 } from "../domain/canonical.ts";
import { withTransaction } from "../db/postgres.ts";
import { PostgresInvestigationStore } from "./postgres-investigation.ts";
import { deterministicInvestigator,validateInvestigation,type InvestigationCall,type InvestigationEvidence } from "./investigation.ts";

type Settings = { model: string; dailyLimit: number; userDailyLimit: number; minIntervalMs: number;
  infer(evidence: readonly InvestigationEvidence[]): Promise<InvestigationCall> };
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
    // Check ownership even when no result exists. No model or quota reservation.
    await this.evidenceStore.evidence(user,run);
    const row = await this.tx(async client => (await client.query(`SELECT * FROM ai_investigations
      WHERE run_id=$1 AND user_id=$2 AND status='FRESH' AND evidence_json IS NOT NULL ORDER BY completed_at DESC,id DESC LIMIT 1`, [run,user])).rows[0]);
    if (!row) return null;
    const evidence = JSON.parse(row.evidence_json) as InvestigationEvidence[];
    const parsed = validateInvestigation(JSON.parse(row.result_json),evidence);
    if (!parsed.ok) return null;
    return { status: "CACHED" as const,freshModelExecution: false,historical: true,reason: null,retryAt: null,
      evidence,baseline: deterministicInvestigator(evidence),snapshotSha256: row.snapshot_sha256 as string,
      investigation: parsed.result,model: row.model as string,generatedAt: row.completed_at as string,
      usage: JSON.parse(row.usage_json) as InvestigationCall["usage"] };
  }
  async investigate(user: string,run: string) {
    const evidence = await this.evidenceStore.evidence(user,run);
    const baseline = deterministicInvestigator(evidence);
    const snapshotSha256 = sha256(canonical({ policy: "investigator-v2",model: this.settings.model,evidence }));
    const unavailable = (reason: string,retryAt: string | null = null) => ({ status: "UNAVAILABLE" as const,freshModelExecution: false,reason,retryAt,baseline,evidence,snapshotSha256 });
    const now = Date.now(); const day = new Date(now).toISOString().slice(0,10);
    const reservation = await this.tx(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${this.schema}:ai-reservation`]);
      // A locked day row arbitrates caches, quota, spacing and one in-flight
      // request across every process. No model request runs in this transaction.
      await client.query("INSERT INTO ai_budget_days(day) VALUES($1) ON CONFLICT DO NOTHING", [day]);
      const budget = (await client.query("SELECT * FROM ai_budget_days WHERE day=$1 FOR UPDATE", [day])).rows[0];
      await client.query(`UPDATE ai_investigations SET status='UNAVAILABLE',completed_at=$1,error_kind='INTERRUPTED_UNKNOWN_USAGE'
        WHERE status='RESERVED' AND requested_at<$2`, [new Date(now).toISOString(),new Date(now-90_000).toISOString()]);
      const cached = (await client.query(`SELECT * FROM ai_investigations WHERE run_id=$1 AND user_id=$2 AND snapshot_sha256=$3
        AND model=$4 AND status='FRESH' ORDER BY completed_at DESC LIMIT 1`, [run,user,snapshotSha256,this.settings.model])).rows[0];
      if (cached) return { cached };
      if (this.settings.dailyLimit === 0 || this.settings.userDailyLimit === 0) return { reason: "BUDGET_DISABLED" };
      if (budget.reservations >= this.settings.dailyLimit) return { reason: "APP_DAILY_BUDGET",retryAt: new Date(Date.parse(`${day}T00:00:00.000Z`)+86_400_000).toISOString() };
      const own = (await client.query("SELECT count(*)::integer AS n FROM ai_investigations WHERE user_id=$1 AND requested_at>=$2 AND requested_at<$3", [user,`${day}T00:00:00.000Z`,new Date(Date.parse(`${day}T00:00:00.000Z`)+86_400_000).toISOString()])).rows[0].n;
      if (own >= this.settings.userDailyLimit) return { reason: "SESSION_DAILY_BUDGET" };
      if ((await client.query("SELECT 1 FROM ai_investigations WHERE status='RESERVED' LIMIT 1")).rowCount) return { reason: "AI_BUSY" };
      if (now-budget.last_reserved_at_ms < this.settings.minIntervalMs) return { reason: "APP_REQUEST_SPACING",retryAt: new Date(budget.last_reserved_at_ms+this.settings.minIntervalMs).toISOString() };
      const id = `ai_${randomUUID()}`;
      await client.query("UPDATE ai_budget_days SET reservations=reservations+1,last_reserved_at_ms=$1 WHERE day=$2", [now,day]);
      await client.query("INSERT INTO ai_investigations(id,run_id,user_id,snapshot_sha256,status,model,requested_at,evidence_json) VALUES($1,$2,$3,$4,'RESERVED',$5,$6,$7)", [id,run,user,snapshotSha256,this.settings.model,new Date(now).toISOString(),JSON.stringify(evidence)]);
      return { id };
    });
    if ("cached" in reservation && reservation.cached) {
      const cached = reservation.cached;
      const parsed = validateInvestigation(JSON.parse(cached.result_json),evidence);
      if (!parsed.ok) return unavailable("CACHED_RESULT_INVALID");
      return { status: "CACHED" as const,freshModelExecution: false,reason: null,retryAt: null,baseline,evidence,snapshotSha256,
        investigation: parsed.result,model: cached.model as string,generatedAt: cached.completed_at as string,usage: JSON.parse(cached.usage_json) as InvestigationCall["usage"] };
    }
    if ("reason" in reservation && reservation.reason) return unavailable(reservation.reason,reservation.retryAt ?? null);
    if (!("id" in reservation) || !reservation.id) return unavailable("RESERVATION_UNAVAILABLE");
    let result: InvestigationCall;
    try { result = await this.settings.infer(evidence); }
    catch { result = { ok: false,result: null,error: "PROVIDER_FAILURE",usage: { promptTokens: null,outputTokens: null,totalTokens: null },httpStatus: null,latencyMs: 0 }; }
    const validated = result.ok ? validateInvestigation(result.result,evidence) : null;
    const ok = validated?.ok === true;
    const completedAt = new Date().toISOString();
    const stored = await this.tx(async client => (await client.query(`UPDATE ai_investigations SET status=$1,completed_at=$2,result_json=$3,usage_json=$4,error_kind=$5
      WHERE id=$6 AND status='RESERVED'`, [ok ? "FRESH" : "UNAVAILABLE",completedAt,ok ? JSON.stringify(validated.result) : null,JSON.stringify(result.usage),ok ? null : result.error ?? "INVALID_MODEL_RESULT",reservation.id])).rowCount === 1);
    if (!stored) return unavailable("RESERVATION_INTERRUPTED");
    if (!ok) return unavailable(result.error ?? "INVALID_MODEL_RESULT");
    return { status: "FRESH" as const,freshModelExecution: true,reason: null,retryAt: null,baseline,evidence,snapshotSha256,
      investigation: validated.result,model: this.settings.model,generatedAt: completedAt,usage: result.usage };
  }
}
