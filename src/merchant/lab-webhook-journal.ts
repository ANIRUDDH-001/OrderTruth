/** Local Lab journal. Never installed by hosted product startup. */
import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";
import type { LabWebhookResult } from "./lab-webhook-adapter.ts";

export async function createLabWebhookJournal(pool: pg.Pool, scopeId: string) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(scopeId)) throw new Error("lab journal: invalid scope");
  await pool.query(`CREATE SCHEMA IF NOT EXISTS lab_webhook;
    CREATE TABLE IF NOT EXISTS lab_webhook.receipts (
      scope_id text NOT NULL, event_id text NOT NULL, result jsonb NOT NULL,
      committed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope_id, event_id))`);
  const active = new AsyncLocalStorage<pg.PoolClient>();
  // The vulnerable writer's query calls share the journal transaction. It cannot
  // acquire an unrelated connection or silently write outside the callback.
  const writerPool = {
    query: (...args: unknown[]) => {
      const client = active.getStore();
      if (!client) throw new Error("lab journal: writer query outside transaction");
      return Reflect.apply(client.query, client, args);
    },
    connect: () => { throw new Error("lab journal: writer may only use query"); },
  } as unknown as pg.Pool;
  async function once(eventId: string, write: () => Promise<LabWebhookResult>): Promise<LabWebhookResult> {
    if (!/^WH-[A-Za-z0-9-]{6,100}$/.test(eventId)) throw new Error("lab journal: invalid event id");
    if (active.getStore()) throw new Error("lab journal: nested transaction forbidden");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '10s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`ordertruth.lab.webhook:${scopeId}:${eventId}`]);
      const previous = await client.query("SELECT event_id FROM lab_webhook.receipts WHERE scope_id = $1 AND event_id = $2", [scopeId, eventId]);
      if (previous.rowCount) { await client.query("COMMIT"); return { outcome: "replay", eventId }; }
      const result = await active.run(client, write);
      if (result.outcome !== "written" || result.eventId !== eventId || !result.result.ok) throw new Error("lab journal: callback did not write successfully");
      await client.query("INSERT INTO lab_webhook.receipts(scope_id,event_id,result) VALUES($1,$2,$3::jsonb)", [scopeId, eventId, JSON.stringify(result)]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  return { once, writerPool };
}
