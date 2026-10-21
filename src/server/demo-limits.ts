import type { Pool } from "pg";
import { withTransaction } from "../db/postgres.ts";
/** A small demo allowance, shared across processes and restarts. Read-only
 * receipts/history never consume it. Failed mutations still consume admission. */
export async function admitDemoAction(pool: Pool,schema: string,user: string,run: string): Promise<boolean> {
  if (schema !== "ordertruth" && !/^qual_[a-f0-9]{20}$/.test(schema)) throw new Error("Invalid schema");
  return withTransaction(pool,async client => {
    await client.query("SELECT set_config('search_path',$1,true)", [`${schema},pg_catalog`]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${schema}:demo-action-budget`]);
    const day = new Date().toISOString().slice(0,10);
    const limits: Array<[string,number]> = [[`day:${day}`,5000],[`user:${day}:${user}`,100],[`run:${run}`,250]];
    for (const [key,limit] of limits) {
      const row = (await client.query("SELECT used FROM demo_action_budgets WHERE key=$1", [key])).rows[0];
      if (row && row.used >= limit) return false;
    }
    for (const [key] of limits) await client.query("INSERT INTO demo_action_budgets(key,used) VALUES($1,1) ON CONFLICT(key) DO UPDATE SET used=demo_action_budgets.used+1", [key]);
    return true;
  });
}
