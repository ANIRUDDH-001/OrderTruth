/** Isolated single-merchant reference store. Never imported by hosted/judge startup. */
import { assertLabSandboxClient, isLabSandboxClient, type LabSandboxClient } from "./lab-sandbox-client.ts";
import { preflightPayee } from "./lab-payee-preflight.ts";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { canonical, sha256 } from "../domain/canonical.ts";
import { verifyCaptureReadback, type OrderReadback } from "../domain/checkout.ts";
import type { Money } from "../domain/money.ts";
import type { DeliveryRow, EventRow } from "../webhooks/inbox.ts";
import { issueCapability, verifyMac } from "../../packages/guard/src/capability.ts";
import { createGuard } from "../../packages/guard/src/guard.ts";
import { migrateGuard } from "../../packages/guard/src/schema.ts";
import { SHOP_SCHEMA_SQL } from "../../packages/lab-merchant/src/schema.ts";
import * as vulnerable from "../../packages/lab-merchant/src/nc/nc3-key-on-path.ts";
import * as corrected from "../../packages/lab-merchant/src/v-a/reference-fix.ts";
import { V_A_CONFIG } from "../../packages/lab-merchant/src/v-a/ordertruth.config.ts";
import { createLabWebhookAdapter, type LabWebhookResult } from "./lab-webhook-adapter.ts";
import { createLabWebhookJournal } from "./lab-webhook-journal.ts";

export type ReferenceConfig = {
  merchantId: string; payeeMerchantId: string; variant: "cross-path" | "corrected";
  mode: "sandbox" | "offline";
};
export type ReferenceBinding = { intentId: string; orderId: string; sku: string; amount: Money };
type InboxReader = {
  getEvent(id: string): EventRow | undefined | Promise<EventRow | undefined>;
  getDelivery(seq: number): DeliveryRow | undefined | Promise<DeliveryRow | undefined>;
};
const checkConfig = (c: ReferenceConfig) => {
  if (!["sandbox", "offline"].includes(c.mode) || !["cross-path", "corrected"].includes(c.variant)
    || ![c.merchantId, c.payeeMerchantId].every(s => /^[A-Za-z0-9_-]{1,128}$/.test(s))) throw new Error("invalid reference configuration");
};

/** Fresh database only: refuses existing schemas rather than silently migrating historical data. */
export async function initializeReferenceStore(pool: pg.Pool, config: ReferenceConfig) {
  checkConfig(config);
  if ((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('shop','ordertruth_guard','lab_reference')")).rowCount) throw new Error("reference database must be fresh");
  const migration = await pool.connect();
  try { await migrateGuard(migration, config.merchantId); } finally { migration.release(); }
  await pool.query(SHOP_SCHEMA_SQL);
  await pool.query(`CREATE SCHEMA lab_reference;
    CREATE TABLE lab_reference.config (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), value jsonb NOT NULL);
    CREATE TABLE lab_reference.bindings(intent_id text PRIMARY KEY REFERENCES shop.intents(id), order_id text UNIQUE NOT NULL);
    CREATE TABLE lab_reference.provider_reads(id text PRIMARY KEY, order_id text NOT NULL, provenance text NOT NULL, debug_id text, response_hash text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE lab_reference.attempts(id text PRIMARY KEY, path text NOT NULL, request_id text NOT NULL, state text NOT NULL,
      result jsonb, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz);
  `);
  await pool.query("INSERT INTO lab_reference.config(value) VALUES($1::jsonb)", [JSON.stringify(config)]);
  // These protect only this NEW, single-merchant/single-primary-intent reference store.
  // Historical guard/schema and vulnerable experiment remain unchanged.
  if (config.variant === "corrected") await pool.query(`CREATE UNIQUE INDEX reference_capture_once ON shop.orders(capture_id);
    CREATE UNIQUE INDEX reference_intent_once ON shop.orders(intent_id)`);
}

export async function registerReferenceIntent(pool: pg.Pool, config: ReferenceConfig, binding: ReferenceBinding) {
  checkConfig(config);
  if (![binding.intentId, binding.orderId, binding.sku].every(s => /^[A-Za-z0-9_-]{1,128}$/.test(s))
    || !Number.isSafeInteger(binding.amount.minor) || binding.amount.minor <= 0 || binding.amount.currency !== "USD"
    || (config.mode === "sandbox" && [binding.intentId, binding.orderId].some(s => s.startsWith("SYN-")))) throw new Error("invalid reference binding");
  await assertConfig(pool, config);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("INSERT INTO shop.intents VALUES($1,$2,$3,$4,$5::jsonb)", [binding.intentId, binding.sku, binding.amount.currency, binding.amount.minor, JSON.stringify([{ sku: binding.sku, qty: 1 }])]);
    await c.query("INSERT INTO lab_reference.bindings VALUES($1,$2)", [binding.intentId, binding.orderId]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
async function assertConfig(pool: pg.Pool, config: ReferenceConfig) {
  const r = (await pool.query("SELECT value FROM lab_reference.config WHERE singleton")).rows[0];
  if (!r || canonical(r.value) !== canonical(config)) throw new Error("reference store configuration mismatch");
}

export async function createReferenceRuntime(o: {
  pool: pg.Pool; aux: pg.Pool; auxConnectionString: string; config: ReferenceConfig;
  capabilityKey: Buffer; testKey?: Buffer;
  /** Trusted, server-owned read-only PayPal client seam. No financial methods accepted. */
  provider: { apiBase: "https://api-m.sandbox.paypal.com"; getOrder(id: string): Promise<OrderReadback> } | LabSandboxClient;
  inbox: InboxReader;
  /** Fault hook for offline process tests only; never enabled for a Sandbox run. */
  afterHandler?: () => Promise<void>;
}) {
  const config = { ...o.config };
  checkConfig(config);
  const selectedProvider=o.provider;
  let sandboxClient:LabSandboxClient|undefined;
  if (config.mode === "sandbox") {
    if (["testKey","fetch","fetchImpl","apiBase","acceptTestAuthority"].some(k=>Object.hasOwn(o,k))) throw new Error("Sandbox runtime refuses test authority or injected transport configuration");
    assertLabSandboxClient(selectedProvider); sandboxClient=selectedProvider;
  } else {
    if (isLabSandboxClient(selectedProvider)) throw new Error("offline runtime refuses live client");
    if (!Buffer.isBuffer(o.testKey) || o.testKey.length<32) throw new Error("offline test key required");
  }
  if (selectedProvider.apiBase !== "https://api-m.sandbox.paypal.com") throw new Error("sandbox provider required");
  if (o.afterHandler && config.mode !== "offline") throw new Error("fault hook requires offline mode");
  await assertConfig(o.pool, config);
  const guard = await createGuard({ pool: o.pool, auxConnectionString: o.auxConnectionString, auxMax: 2,
    merchantId: config.merchantId, buildId: "isolated-reference-v1", paypalEnv: "sandbox", capabilityKey: o.capabilityKey,
    config: V_A_CONFIG, freshnessMs: 300_000, timeouts: { lockMs: 5000, statementMs: 10_000, connectionMs: 5000 },
    ...(config.mode === "offline" ? { acceptTestAuthority: true, testAuthorityKey: o.testKey! } : {}) });
  const journal = await createLabWebhookJournal(o.pool, "reference-v1");
  const handlers = config.variant === "corrected" ? corrected : vulnerable;
  const provenance = config.mode === "offline" ? "MOCK_READBACK" : "PAYPAL_READBACK";
  const key = config.mode === "offline" ? o.testKey! : o.capabilityKey;
  async function readOrder(orderId:string):Promise<OrderReadback> {
    let raw:OrderReadback,debugId:string|null=null;
    if (sandboxClient) {
      const call=await sandboxClient.getOrder(orderId,{correlationId:`lab_${randomUUID()}`});raw=call.body;
      debugId=typeof call.debugId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(call.debugId)?call.debugId:null;
    } else raw=await (selectedProvider as {getOrder(id:string):Promise<OrderReadback>}).getOrder(orderId);
    await o.pool.query("INSERT INTO lab_reference.provider_reads(id,order_id,provenance,debug_id,response_hash) VALUES($1,$2,$3,$4,$5)",[randomUUID(),orderId,provenance,debugId,sha256(canonical(raw))]);
    return raw;
  }
  async function binding(where: "i.id" | "b.order_id", value: string) {
    const r = (await o.pool.query(`SELECT i.id, i.currency, i.amount_minor::text, b.order_id FROM shop.intents i JOIN lab_reference.bindings b ON b.intent_id=i.id WHERE ${where}=$1`, [value])).rows[0];
    if (!r || r.currency !== "USD") throw new Error("foreign reference purchase");
    return { intentId: String(r.id), orderId: String(r.order_id), amount: { currency: "USD" as const, minor: Number(r.amount_minor) } };
  }
  async function admit(b: Awaited<ReturnType<typeof binding>>, raw: OrderReadback) {
    const verdict = verifyCaptureReadback(raw, { orderId: b.orderId, customId: b.intentId, amount: b.amount });
    if (verdict.state !== "captured" || !verdict.captureId || !preflightPayee(raw,config.payeeMerchantId).eligible
      || (config.mode === "sandbox" && [b.intentId, b.orderId, verdict.captureId].some(s => s.startsWith("SYN-")))) throw new Error("ineligible reference capture");
    const responseHash = sha256(canonical(raw));
    const capability = await issueCapability({ op: o.pool, aux: o.aux }, {
      merchantId: config.merchantId, paypalEnv: "sandbox", payeeMerchantId: config.payeeMerchantId,
      paypalOrderId: b.orderId, captureId: verdict.captureId, intentId: b.intentId, status: "COMPLETED",
      currency: b.amount.currency, amountMinor: String(b.amount.minor), observedAt: new Date().toISOString(),
      responseHash, observationHash: sha256(canonical({ responseHash, observed: randomUUID() })),
      ...(config.mode === "offline" ? { authority: "TEST" as const, provenance: "SYNTHETIC_FIXTURE" as const, verificationMethod: "FIXTURE" as const }
        : { authority: "PAYPAL" as const, provenance: "PAYPAL_READBACK" as const, verificationMethod: "READBACK" as const }),
    }, key, { buildId: "isolated-reference-v1" });
    if (!verifyMac(capability, key)) throw new Error("invalid admitted capability");
    return { pool: journal.writerPool, afterCheck: async () => {}, guard, capability };
  }
  async function attempt(path: string, request: string, run: () => Promise<LabWebhookResult | { outcome: "ignored" }>) {
    const id = randomUUID();
    await o.pool.query("INSERT INTO lab_reference.attempts(id,path,request_id,state) VALUES($1,$2,$3,'started')", [id,path,request]);
    try {
      const result = await run();
      await o.pool.query("UPDATE lab_reference.attempts SET state='finished',result=$2::jsonb,finished_at=now() WHERE id=$1", [id,JSON.stringify(result)]);
      return result;
    } catch (e) {
      await o.pool.query("UPDATE lab_reference.attempts SET state='failed',result=$2::jsonb,finished_at=now() WHERE id=$1", [id,JSON.stringify({ error: e instanceof Error ? e.name : "unknown" })]);
      throw e;
    }
  }
  return {
    knownEvent: async (eventId:string, bodyHash:string) => {
      const event=await o.inbox.getEvent(eventId);
      const delivery=event && await o.inbox.getDelivery(event.first_delivery_seq);
      return event && delivery && delivery.state === "verified" && delivery.reason === "paypal_postback SUCCESS"
        && delivery.claimed_event_id === eventId && delivery.body_sha256 === bodyHash ? event : null;
    },
    close: () => guard.close(),
    returnFor: (intentId: string) => attempt("checkout_return", intentId, async () => {
      const b = await binding("i.id", intentId);
      const eventId = `WH-RETURN-${sha256(b.orderId).slice(0,32)}`;
      return journal.once(eventId, async () => {
        const d = await admit(b, await readOrder(b.orderId));
        const result = await handlers.handleCheckoutReturn(d, { intentId, observationId: d.capability.evidenceId });
        if (!result.ok) throw new Error("return writer rejected capture");
        await o.afterHandler?.();
        return { outcome: "written", eventId, provenance, result };
      });
    }),
    webhook: (eventId: string) => attempt("webhook", eventId, async () => {
      const event = await o.inbox.getEvent(eventId);
      const delivery = event && await o.inbox.getDelivery(event.first_delivery_seq);
      if (!event || !delivery || delivery.state !== "verified" || delivery.reason !== "paypal_postback SUCCESS"
        || delivery.claimed_event_id !== eventId || event.event_id !== eventId) throw new Error("verified processing proof required");
      if (["disagreed","foreign","ignored","failed"].includes(event.state)) return {outcome:"ignored"};
      if (event.state !== "processed") throw new Error("event processing pending");
      if (event.event_type === "CHECKOUT.ORDER.APPROVED") return { outcome: "ignored" };
      if (!(await o.pool.query("SELECT 1 FROM lab_reference.bindings WHERE order_id=$1",[event.order_id])).rowCount) return {outcome:"ignored"};
      const summary = JSON.parse(event.summary_json);
      const b = await binding("b.order_id", event.order_id ?? "");
      const adapter = createLabWebhookAdapter({ paypalEnv: "sandbox", apiBase: selectedProvider.apiBase, provenance,
        merchantId: config.merchantId, payeeMerchantId: config.payeeMerchantId, orderId: b.orderId,
        captureId: summary.resource.id, intentId: b.intentId, observationId: eventId, amount: b.amount }, {
        loadProcessed: async () => ({ event, delivery }), readback: id => readOrder(id), merchantDeps: raw => admit(b, raw),
        once: journal.once, handler: async (d,i) => { const result = await handlers.handleCaptureWebhook(d,i); await o.afterHandler?.(); return result; },
      });
      return adapter(eventId);
    }),
  };
}
