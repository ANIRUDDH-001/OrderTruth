import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";
import type { GuardPools } from "../../packages/guard/src/commit.ts";
import { REQUIRED_CREATE_ORDER_RETURNS, type GuardConfig } from "../../packages/guard/src/config.ts";
import { migrateGuard } from "../../packages/guard/src/schema.ts";
import type { SyntheticFixture } from "../../packages/guard/src/testing/index.ts";
import { startFaultProxy, type FaultProxy } from "../../packages/verifier/src/proxy.ts";
import { createDisposableDatabase, type DisposableDatabase } from "./harness.ts";

/** A migrated disposable merchant database, a fault proxy in front of it, and guard pools (operation pool via the proxy). */
export type GuardEnv = { db: DisposableDatabase; proxy: FaultProxy; pools: GuardPools; opConfig: () => pg.PoolConfig; auxConfig: () => pg.PoolConfig;
  auxConnectionString: (user?: { user: string; password: string }) => string; close(): Promise<void> };

export async function setupGuardEnv(merchantId = "SYN-M-A", o: { opMax?: number; withShop?: boolean } = {}): Promise<GuardEnv> {
  const db = await createDisposableDatabase();
  await migrateGuard(db.client, merchantId);
  if (o.withShop) await db.client.query(SHOP_SQL);
  const proxy = await startFaultProxy({ listenPort: 0, controlPort: 0, target: { host: String(db.config.host), port: Number(db.config.port) } });
  const opConfig = (): pg.PoolConfig => ({ ...db.config, host: "127.0.0.1", port: proxy.port, max: o.opMax ?? 4, connectionTimeoutMillis: 5000 });
  const auxConfig = (): pg.PoolConfig => ({ ...db.config, max: 2, connectionTimeoutMillis: 5000 });
  const pools: GuardPools = { op: new pg.Pool(opConfig()), aux: new pg.Pool(auxConfig()) };
  pools.op.on("error", () => {}); pools.aux.on("error", () => {});
  const auxConnectionString = (as?: { user: string; password: string }) => {
    const c = db.config, e = encodeURIComponent;
    return `postgres://${e(as?.user ?? String(c.user))}:${e(as?.password ?? String(c.password))}@${String(c.host)}:${Number(c.port)}/${e(String(c.database))}`;
  };
  return { db, proxy, pools, opConfig, auxConfig, auxConnectionString, async close() { await pools.op.end(); await pools.aux.end(); await proxy.close(); await db.drop(); } };
}

export const fixture = JSON.parse(readFileSync(new URL("../../packages/guard/fixtures/synthetic-fixture.json", import.meta.url), "utf8")) as SyntheticFixture;

/** Test merchant shop schema (shape of the Gate A lab merchant; no unique key on intent_id, as in REF-BUG-1). */
export const SHOP_SQL = `
CREATE SCHEMA shop;
CREATE TABLE shop.intents (id text PRIMARY KEY, sku text NOT NULL, currency text NOT NULL, amount_minor bigint NOT NULL, line_items jsonb NOT NULL);
CREATE TABLE shop.orders (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, intent_id text NOT NULL, paypal_order_id text NOT NULL,
  capture_id text NOT NULL, amount_minor bigint NOT NULL, currency text NOT NULL, created_by_path text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO shop.intents VALUES
  ('SYN-INT-1', 'SKU-1', 'USD', 1000, '[{"sku":"SKU-1","qty":1}]'),
  ('SYN-INT-2', 'SKU-2', 'USD', 2500, '[{"sku":"SKU-2","qty":1}]'),
  ('SYN-INT-3', 'SKU-3', 'EUR', 990,  '[{"sku":"SKU-3","qty":1}]');`;

/** The V-A trusted configuration (same literal as tests/v3/config.test.ts). */
const IDENTITY = [...REQUIRED_CREATE_ORDER_RETURNS];
export const V_A_CONFIG: GuardConfig = {
  createOrder: {
    sql: "INSERT INTO shop.orders (intent_id, paypal_order_id, capture_id, amount_minor, currency, created_by_path) VALUES ($1, $2, $3, $4, $5, $6) "
      + "RETURNING id, intent_id, paypal_order_id, capture_id, amount_minor::text AS amount_minor, currency",
    params: ["intent.id", "capture.paypalOrderId", "capture.id", "capture.amountMinor", "capture.currency", "path.id"], returns: IDENTITY },
  orderLocator: {
    sql: "SELECT id, intent_id, paypal_order_id, capture_id, amount_minor::text AS amount_minor, currency FROM shop.orders WHERE id = $1",
    params: ["order.id"], returns: IDENTITY },
  intentLocator: {
    sql: "SELECT id, sku, currency, amount_minor::text AS amount_minor, line_items FROM shop.intents WHERE id = $1",
    params: ["intent.id"], returns: ["id", "sku", "currency", "amount_minor", "line_items"] },
  singleTenantMerchantSchema: true,
  sites: [{ siteId: "checkout_return:order-write", pathId: "checkout_return" }, { siteId: "webhook:order-write", pathId: "webhook" }],
};

export const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error("timed out"); await new Promise(r => setTimeout(r, 20)); }
};

/** Runs a TypeScript child entry point under the current Node, without blocking this process's event loop (the fault proxy lives here). */
export function runChild(path: string, arg: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", path, arg], { env: { ...process.env } });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`child timed out: ${stderr}`)); }, 30_000);
    p.stdout.on("data", d => { stdout += d; }); p.stderr.on("data", d => { stderr += d; });
    p.on("close", code => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
  });
}
