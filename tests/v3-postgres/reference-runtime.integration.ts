/** OFFLINE MOCK PROVIDER ONLY: real intake/processor, committed capabilities and Lab PostgreSQL writes. */
import { mkdirSync, writeFileSync } from "node:fs";
import pg from "pg";
import { buildWebhookApp } from "../../src/webhooks/app.ts";
import { createReferenceWorkflow } from "../../src/merchant/lab-reference-workflow.ts";
import { signedHeaders } from "../helpers/webhook-fixtures.ts";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createReferenceRuntime, initializeReferenceStore, registerReferenceIntent, type ReferenceConfig } from "../../src/merchant/lab-reference-runtime.ts";
import type { OrderReadback } from "../../src/domain/checkout.ts";
import { captureEvent, capturedAtPayPalUnknownLocally, deliver, orderEvent, setupWebhook, type Setup } from "../helpers/webhook-fixtures.ts";
import { createDisposableDatabase, type DisposableDatabase } from "./harness.ts";

let db: DisposableDatabase, pool: pg.Pool, aux: pg.Pool, s: Setup;
let clock=Date.now();
let runtimes: Array<Awaited<ReturnType<typeof createReferenceRuntime>>> = [];
const oldMode = process.env.ORDERTRUTH_GUARD_MODE;
beforeAll(() => { process.env.ORDERTRUTH_GUARD_MODE = "verifier"; });
afterAll(() => { if (oldMode === undefined) delete process.env.ORDERTRUTH_GUARD_MODE; else process.env.ORDERTRUTH_GUARD_MODE = oldMode; });
beforeEach(async () => {
  db = await createDisposableDatabase();
  pool = new pg.Pool({ ...db.config, max: 8, connectionTimeoutMillis: 5000 });
  aux = new pg.Pool({ ...db.config, max: 4, connectionTimeoutMillis: 5000 });
  pool.on("error", () => {}); aux.on("error", () => {});
  clock=Date.now(); s = await setupWebhook({now:()=>clock});
});
afterEach(async () => { for (const r of runtimes.splice(0)) await r.close(); await s.svc.app.close(); s.store.close(); await pool.end(); await aux.end(); await db.drop(); });
const rows = async () => (await pool.query("SELECT * FROM shop.orders ORDER BY created_at,id")).rows;
const count = async () => (await rows()).length;
const config = (variant: ReferenceConfig["variant"] = "corrected", mode: ReferenceConfig["mode"] = "offline"): ReferenceConfig => ({ merchantId: "reference-merchant", payeeMerchantId: "MERCHANTFAKE123", variant, mode });
async function runtime(c: ReferenceConfig, hooks: { afterHandler?: () => Promise<void> } = {}) {
  const url = `postgres://${encodeURIComponent(String(db.config.user))}:${encodeURIComponent(String(db.config.password))}@${db.config.host}:${db.config.port}/${db.name}`;
  const r = await createReferenceRuntime({ pool, aux, auxConnectionString: url, config: c,
    capabilityKey: Buffer.alloc(32, 11), ...(c.mode === "offline" ? {testKey: Buffer.alloc(32,12)} : {}),
    provider: { apiBase: "https://api-m.sandbox.paypal.com", getOrder: async (id:string) => (await s.paypal.getOrder(id, { correlationId: "offline-reference" })).body as OrderReadback },
    inbox: s.svc.inbox, ...hooks });
  runtimes.push(r); return r;
}
async function purchase(c: ReferenceConfig) {
  const p = await capturedAtPayPalUnknownLocally(s);
  await registerReferenceIntent(pool, c, { intentId: p.intentId, orderId: p.orderId, sku: "reference-item", amount: { currency: "USD", minor: 100 } });
  return p;
}
async function eventFor(p: Awaited<ReturnType<typeof purchase>>) {
  const e = captureEvent({ orderId: p.orderId, captureId: p.captureId, customId: p.intentId });
  expect((await deliver(s,e)).status).toBe(200); await s.svc.processor.drain(); return e;
}
describe("assembled reference merchant offline integration", () => {
  for (const variant of ["cross-path","corrected"] as const) it(`${variant}: verified intake to actual writer, replay and distinct events`, async () => {
    const c = config(variant); await initializeReferenceStore(pool,c); const p = await purchase(c); const r = await runtime(c);
    const financialBefore = s.fake.calls.filter(x => x.method === "POST" && x.path.startsWith("/v2/")).length;
    expect(await r.returnFor(p.intentId)).toMatchObject({ outcome: "written" });
    const e = await eventFor(p);
    expect(await r.webhook(e.id)).toMatchObject({ outcome: "written", provenance: "MOCK_READBACK" });
    expect(await count()).toBe(variant === "corrected" ? 1 : 2);
    expect((await deliver(s,e)).body.result).toBe("duplicate");
    expect(await r.webhook(e.id)).toMatchObject({ outcome: "replay" });
    const distinct = await eventFor(p);
    expect(distinct.id).not.toBe(e.id);
    expect(await r.webhook(distinct.id)).toMatchObject({ outcome: "written", result: { created: false } });
    expect(await count()).toBe(variant === "corrected" ? 1 : 2);
    expect(s.fake.calls.filter(x => x.method === "POST" && x.path.startsWith("/v2/"))).toHaveLength(financialBefore);
    const attempts = (await pool.query("SELECT path,request_id,state,result FROM lab_reference.attempts ORDER BY started_at")).rows;
    expect(attempts).toHaveLength(4); expect(attempts.every(a => a.state === "finished")).toBe(true);
    mkdirSync(".work/runs/g0-g3-20261105/g2",{ recursive:true });
    writeFileSync(`.work/runs/g0-g3-20261105/g2/${variant}.json`,JSON.stringify({ provenance:"OFFLINE_MOCK_PROVIDER", attempts, rows:await rows() },null,2));
    // Proof storage and merchant storage remain different; no judge repair or SQLite merchant insertion.
    expect(s.store.db.prepare("SELECT count(*) AS n FROM merchant_orders").get()).toMatchObject({ n: 0 });
  });
  it("isolated HTTP ingress automatically invokes the writer after signature/readback; no capture routes", async () => {
    const c=config();await initializeReferenceStore(pool,c);const p=await purchase(c);const r=await runtime(c);
    const workflow=createReferenceWorkflow({intake:s.svc.intake,processor:s.svc.processor,runtime:r});
    const app=await buildWebhookApp({intake:workflow,maxBodyBytes:65536,log:s.log,rateLimit:{perMinute:120,burst:20}});
    try {
      expect(await workflow.onCheckoutReturn(p.intentId)).toMatchObject({outcome:"written"});
      const event=captureEvent({orderId:p.orderId,captureId:p.captureId,customId:p.intentId});
      const raw=JSON.stringify(event);
      const response=await app.inject({method:"POST",url:"/webhooks/paypal",payload:raw,headers:signedHeaders(raw)});
      expect(response.statusCode).toBe(200);expect(await count()).toBe(1);
      for(let i=0;i<5;i++)expect((await app.inject({method:"POST",url:"/webhooks/paypal",payload:raw,headers:signedHeaders(raw)})).statusCode).toBe(200);
      expect(s.fake.calls.filter(call=>call.path === "/v1/notifications/verify-webhook-signature")).toHaveLength(1);
      expect((await pool.query("SELECT path,state FROM lab_reference.attempts ORDER BY started_at")).rows).toEqual([{path:"checkout_return",state:"finished"},...Array.from({length:6},()=>({path:"webhook",state:"finished"}))]);
      expect((await app.inject({method:"POST",url:"/capture",payload:{}})).statusCode).toBe(404);
      expect((await app.inject({method:"POST",url:"/refund",payload:{}})).statusCode).toBe(404);
    } finally {await app.close();}
  });
  it("verified transient readback failure retries locally without another signature postback",async()=>{
    const c=config();await initializeReferenceStore(pool,c);const p=await purchase(c);const r=await runtime(c);
    const workflow=createReferenceWorkflow({intake:s.svc.intake,processor:s.svc.processor,runtime:r});
    const event=captureEvent({orderId:p.orderId,captureId:p.captureId,customId:p.intentId});const raw=Buffer.from(JSON.stringify(event));
    s.fake.faults.get="500";
    expect((await workflow.receive(raw,signedHeaders(raw.toString()),"offline-transient")).status).toBe(503);
    expect(await count()).toBe(0);
    s.fake.faults={};clock+=5001;
    expect((await workflow.receive(raw,signedHeaders(raw.toString()),"offline-retry")).status).toBe(200);
    expect(await count()).toBe(1);
    expect(s.fake.calls.filter(call=>call.path === "/v1/notifications/verify-webhook-signature")).toHaveLength(1);
  });
  it("Sandbox runtime rejects injected fake readbacks instead of issuing PAYPAL authority", async () => {
    const c=config("corrected","sandbox");await initializeReferenceStore(pool,c);const p=await purchase(c);
    await expect(runtime(c)).rejects.toThrow(/refuses test authority|trusted Sandbox/);
    expect((await pool.query("SELECT * FROM ordertruth_guard.capture_evidence")).rows).toHaveLength(0);
    expect(await count()).toBe(0);
  });
  it("APPROVED with no capture cannot create an order", async () => {
    const c=config(); await initializeReferenceStore(pool,c);
    const p=await s.checkout.createOrder("offline-approved", {checkoutKey:"approved-reference-test-key-0001"});
    await registerReferenceIntent(pool,c,{intentId:p.intentId,orderId:p.orderId,sku:"sku",amount:{currency:"USD",minor:100}});
    s.fake.approve(p.orderId);
    const e=orderEvent({orderId:p.orderId,customId:p.intentId});
    await deliver(s,e); await s.svc.processor.drain(); const r=await runtime(c);
    expect(await r.webhook(e.id)).toEqual({outcome:"ignored"});
    await expect(r.returnFor(p.intentId)).rejects.toThrow("ineligible"); expect(await count()).toBe(0);
  });
  it("rejects invalid signature, foreign reference binding and mismatched capture", async () => {
    const c=config(); await initializeReferenceStore(pool,c); const p=await purchase(c); const r=await runtime(c);
    const bad=captureEvent({orderId:p.orderId,captureId:p.captureId,customId:p.intentId});
    expect((await deliver(s,bad,{sig:"invalid"})).status).toBe(400);
    await expect(r.webhook(bad.id)).rejects.toThrow("proof");
    const foreign=await capturedAtPayPalUnknownLocally(s); const e=await eventFor(foreign);
    expect(await r.webhook(e.id)).toMatchObject({outcome:"ignored"});
    const wrong=captureEvent({orderId:p.orderId,captureId:"WRONGCAPTURE",customId:p.intentId});
    await deliver(s,wrong); await s.svc.processor.drain();
    expect(await r.webhook(wrong.id)).toMatchObject({outcome:"ignored"}); expect(await count()).toBe(0);
  });
  it("corrected capture commit survives an interrupted journal and runtime restart", async () => {
    const c=config(); await initializeReferenceStore(pool,c); const p=await purchase(c);
    const interrupted=await runtime(c,{afterHandler:async()=>{throw new Error("offline crash window");}});
    await expect(interrupted.returnFor(p.intentId)).rejects.toThrow("crash window");
    expect(await count()).toBe(1);
    const restarted=await runtime(c);
    expect(await restarted.returnFor(p.intentId)).toMatchObject({outcome:"written",result:{created:false}});
    expect(await count()).toBe(1);
  });
  it("actual process death after corrected commit reuses the order after restart", async () => {
    const c=config();await initializeReferenceStore(pool,c);const p=await purchase(c);
    const raw=(await s.paypal.getOrder(p.orderId,{correlationId:"offline-child"})).body;
    const path=fileURLToPath(new URL("./reference-crash-child.ts",import.meta.url));
    const child=await new Promise<{code:number|null;signal:NodeJS.Signals|null;stderr:string;stdout:string}>((resolve,reject)=>{
      const processChild=spawn(process.execPath,["--import","tsx",path,JSON.stringify({db:db.config,config:c,raw,intentId:p.intentId})],{env:process.env,windowsHide:true});
      let stderr="",stdout="";processChild.stderr.on("data",d=>{stderr+=d;});processChild.stdout.on("data",d=>{stdout+=d;});
      const timer=setTimeout(()=>{processChild.kill("SIGKILL");reject(new Error("reference child deadline"));},20000);
      processChild.on("error",e=>{clearTimeout(timer);reject(e);});
      processChild.on("close",(code,signal)=>{clearTimeout(timer);resolve({code,signal,stderr,stdout});});
    });
    mkdirSync(".work/runs/g2-g3-v4-20261105/g2",{recursive:true});
    const cleanStderr=child.stderr.split(String(db.config.password)).join("[REDACTED]");
    writeFileSync(".work/runs/g2-g3-v4-20261105/g2/child-stderr.txt",cleanStderr);
    const death={provenance:"OFFLINE_MOCK_PROVIDER",code:child.code,signal:child.signal,stderrBytes:Buffer.byteLength(cleanStderr),beforeRestart:await rows(),journalBefore:(await pool.query("SELECT event_id FROM lab_webhook.receipts")).rows,attempts:(await pool.query("SELECT path,state FROM lab_reference.attempts")).rows};
    writeFileSync(".work/runs/g2-g3-v4-20261105/g2/process-death.json",JSON.stringify(death,null,2));
    expect(death.journalBefore).toHaveLength(0);
    expect(child.stdout).toBe("REFERENCE_COMMITTED_CRASH_HOOK\n");
    // Windows terminates self-SIGKILL with exit 1 and no POSIX signal. Require
    // the crash hook marker as well as the exact platform termination result.
    expect(child.signal).toBe(process.platform === "win32" ? null : "SIGKILL");
    expect(child.code).toBe(process.platform === "win32" ? 1 : null);
    expect(await count(),child.stderr).toBe(1);
    expect((await pool.query("SELECT state FROM lab_reference.attempts")).rows).toEqual([{state:"started"}]);
    const restarted=await runtime(c);
    expect(await restarted.returnFor(p.intentId)).toMatchObject({outcome:"written",result:{created:false}});
    expect(await count()).toBe(1);
    expect((await pool.query("SELECT event_id FROM lab_webhook.receipts")).rows).toHaveLength(1);
    writeFileSync(".work/runs/g2-g3-v4-20261105/g2/process-death-after-restart.json",JSON.stringify({provenance:"OFFLINE_MOCK_PROVIDER",rows:await rows(),journalAfter:(await pool.query("SELECT event_id FROM lab_webhook.receipts")).rows,attempts:(await pool.query("SELECT path,state,result FROM lab_reference.attempts ORDER BY started_at")).rows},null,2));
  });
  it("two runtime instances concurrently admit the same capture exactly once", async () => {
    const c=config(); await initializeReferenceStore(pool,c); const p=await purchase(c); const a=await runtime(c),b=await runtime(c);const e=await eventFor(p);
    await Promise.all([a.returnFor(p.intentId),b.webhook(e.id),a.webhook(e.id)]);expect(await count()).toBe(1);
  });
  it("distinct intents remain separate purchases; direct conflicting writes are constrained", async () => {
    const c=config();await initializeReferenceStore(pool,c);const a=await purchase(c),b=await purchase(c);const r=await runtime(c);
    await Promise.all([r.returnFor(a.intentId),r.returnFor(b.intentId)]);expect(await count()).toBe(2);
    await expect(pool.query("INSERT INTO shop.orders(intent_id,paypal_order_id,capture_id,amount_minor,currency,created_by_path) SELECT intent_id,paypal_order_id,capture_id,amount_minor,currency,'outside-guard' FROM shop.orders LIMIT 1")).rejects.toMatchObject({code:"23505"});
  });
  it("rejects synthetic real-mode bindings and mismatched store configuration", async () => {
    const c=config("corrected","sandbox");await initializeReferenceStore(pool,c);
    await expect(registerReferenceIntent(pool,c,{intentId:"SYN-INT-1",orderId:"SYN-ORD-1",sku:"sku",amount:{currency:"USD",minor:100}})).rejects.toThrow("binding");
    await expect(runtime({...c,mode:"offline",merchantId:"another"})).rejects.toThrow("configuration mismatch");
  });
});
