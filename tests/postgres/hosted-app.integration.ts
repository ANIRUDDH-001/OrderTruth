import { randomBytes } from "node:crypto";
import { afterAll,beforeAll,expect,it,vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPostgresPool } from "../../src/db/postgres.ts";
import { loadPostgresConfig } from "../../src/config.ts";
import { buildHostedApp } from "../../src/server/hosted-app.ts";
import { env } from "./local-db.ts";
import {PostgresCheckoutStore} from '../../src/db/postgres-checkout.ts';
import {PostgresWebhookInbox} from '../../src/webhooks/postgres-inbox.ts';
import {EventSchema,summarizeEvent} from '../../src/webhooks/event.ts';
import {captureEvent} from '../helpers/webhook-fixtures.ts';
const schema = `qual_${randomBytes(10).toString("hex")}`;
const admin = createPostgresPool(env.DATABASE_URL!);
const origin = "http://127.0.0.1:3333";
const config = loadPostgresConfig({ DATABASE_URL: env.DATABASE_URL,PAYPAL_ENV: "sandbox",PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
  PAYPAL_CLIENT_ID: "synthetic-client-only",PAYPAL_CLIENT_SECRET: "synthetic-secret-only",APP_ORIGIN: origin,AUTH_SECRET: randomBytes(32).toString("hex") });
let app: FastifyInstance;
const network = vi.spyOn(globalThis,"fetch").mockImplementation(async () => { throw new Error("Unexpected provider network call"); });
beforeAll(async () => { app = await buildHostedApp(config,{ schema,staticFiles: false }); await app.ready(); });
afterAll(async () => { await app?.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); network.mockRestore(); });
it("starts without provider calls and denies financial endpoints to a real guest session",async () => {
  expect((await app.inject({ url: "/" })).statusCode).toBe(404);
  expect((await app.inject({ url: "/owner/" })).statusCode).toBe(404);
  expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
  expect((await app.inject({ url: "/api/health" })).json().schemaVersion).toBe(9);
  const readiness = await app.inject({ url: "/api/readiness" });
  expect(readiness.statusCode).toBe(200);
  expect(readiness.json()).toEqual({ ready: true,persistence: "postgresql",schemaVersion: 9,backendContract: "phase1-core-v1" });
  expect(readiness.headers["cache-control"]).toBe("no-store");
  const signed = await app.inject({ method: "POST",url: "/api/auth/sign-in/anonymous",headers: { origin },payload: {} });
  expect(signed.statusCode).toBe(200);
  const cookie = signed.cookies.map(c => `${c.name}=${c.value}`).join("; ");
  for (const url of ["/api/orders","/api/orders/FAKEORDER123/capture","/api/orders/FAKEORDER123/readback"]) {
    const denied = await app.inject({ method: "POST",url,headers: { origin,cookie,"x-owner": "true","x-checkout-key": "synthetic-checkout-key" },payload: {} });
    expect(denied.statusCode).toBe(403);
  }
  expect((await app.inject({ url: "/api/paypal/browser-config",headers: { cookie } })).statusCode).toBe(403);
  expect(network).not.toHaveBeenCalled();
});
it("requires recent owner sign-in before financial actions",async () => {
  const signed = await app.inject({ method: "POST",url: "/api/auth/sign-in/anonymous",headers: { origin },payload: {},remoteAddress: "192.0.2.80" });
  const cookie = signed.cookies.map(c => `${c.name}=${c.value}`).join("; ");
  const session = (await app.inject({ url: "/api/session",headers: { cookie } })).json();
  // Explicit server-configured owner fixture; there is no route to do this.
  await admin.query(`UPDATE ${schema}.ot_auth_user SET "isAnonymous"=false WHERE id=$1`, [session.userId]);
  config.ownerIds.add(session.userId);
  expect((await app.inject({ url: "/api/paypal/browser-config",headers: { cookie } })).statusCode).toBe(200);
  await admin.query(`UPDATE ${schema}.ot_auth_session SET "createdAt"=now()-interval '30 minutes' WHERE "userId"=$1`, [session.userId]);
  expect((await app.inject({ url:'/api/paypal/browser-config',headers:{cookie} })).json().paymentActionsAllowed).toBe(false);
  const denied=await app.inject({ method: "POST",url: "/api/orders",headers: { origin,cookie,"x-checkout-key": "synthetic-checkout-key" },payload: {} });
  expect(denied.statusCode).toBe(403);expect(denied.json().error).toBe('owner_reauthentication_required');
  expect(network).not.toHaveBeenCalled();
});
it("fails readiness closed on a schema-version mismatch without exposing configuration",async () => {
  await admin.query(`INSERT INTO ${schema}.ordertruth_postgres_migrations(version) VALUES(10)`);
  try {
    const response = await app.inject({ url: "/api/readiness" });
    expect(response.statusCode).toBe(503); expect(response.json()).toEqual({ ready: false });
  } finally { await admin.query(`DELETE FROM ${schema}.ordertruth_postgres_migrations WHERE version=10`); }
});

it("keeps liveness available while PostgreSQL cannot serve readiness and recovers after release",async () => {
  const blocker = await admin.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(`LOCK TABLE ${schema}.ordertruth_postgres_migrations IN ACCESS EXCLUSIVE MODE`);
    const [health, readiness] = await Promise.all([app.inject({ url:"/api/health" }),app.inject({ url:"/api/readiness" })]);
    expect(health.statusCode).toBe(200);
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toEqual({ ready:false });
  } finally {
    try { await blocker.query("ROLLBACK"); } finally { blocker.release(); }
  }
  expect((await app.inject({ url:"/api/readiness" })).statusCode).toBe(200);
  expect(network).not.toHaveBeenCalled();
});

it("limits webhook ingress before body parsing and durable intake",async () => {
  const guarded = await buildHostedApp({ ...config,paypal: { ...config.paypal,webhookId: "SYNTHETICWEBHOOK" },webhookIngress: { ...config.webhookIngress,ratePerMinute: 1,rateBurst: 1 } },{ schema,staticFiles: false });
  try {
    const first = await guarded.inject({ method: "POST",url: "/api/paypal/webhook",headers: { "content-type": "application/json" },payload: "{}" });
    expect(first.statusCode).not.toBe(200);
    const before = (await admin.query(`SELECT count(*)::integer AS n FROM ${schema}.webhook_deliveries`)).rows[0].n;
    const second = await guarded.inject({ method: "POST",url: "/api/paypal/webhook",headers: { "content-type": "application/json" },payload: "{}" });
    expect(second.statusCode).toBe(429);
    expect((await admin.query(`SELECT count(*)::integer AS n FROM ${schema}.webhook_deliveries`)).rows[0].n).toBe(before);
    expect(network).not.toHaveBeenCalled();
  } finally { await guarded.close(); }
});

it("emits request-template correlation without request secrets or raw paths",async () => {
  const lines: string[] = [];
  const observed = await buildHostedApp(config,{schema,staticFiles:false,logStream:{write: (line: string) => { lines.push(line); }}});
  try {
    const response=await observed.inject({url:"/api/scenarios/PRIVATECASE?token=PRIVATEQUERY",headers:{cookie:"session=PRIVATECOOKIE",authorization:"Bearer PRIVATEAUTH","x-request-id":"PRIVATECLIENT"}});
    const logs=lines.join("");
    expect(logs).toContain(response.headers["x-request-id"]);
    expect(logs).toContain("/api/scenarios/:runId");
    for(const secret of ["PRIVATECASE","PRIVATEQUERY","PRIVATECOOKIE","PRIVATEAUTH","PRIVATECLIENT"]) expect(logs).not.toContain(secret);
  }finally{await observed.close()}
});

it('recovers an expired verified webhook lease on listening without another delivery, and counts it in the release drain',async()=>{
  const order='SYNTHETICRECOVERYORDER',capture='SYNTHETICRECOVERYCAPTURE';
  const store=new PostgresCheckoutStore(admin,schema),inbox=new PostgresWebhookInbox(admin,schema,'SYNTHETIC_QUALIFICATION');
  const f=await store.createCheckout('synthetic-webhook-listener-recovery');await store.attachOrder(f.attempt.id,order);
  const event=summarizeEvent(EventSchema.parse(captureEvent({orderId:order,captureId:capture,customId:f.intent.id})));
  const delivery=await inbox.recordDelivery({claimedEventId:event.id,claimedEventType:event.event_type,bodySha256:'a'.repeat(64),bodyBytes:100,correlationId:'synthetic-recovery',nowMs:Date.now()});
  await inbox.acceptVerified(delivery,event,{ms:1,debugId:null},'synthetic-recovery');
  expect((await inbox.claimNext(Date.now()-100,50))?.event_id).toBe(event.id);
  let closed=false,entered=false,release!:()=>void;const delayed=new Promise<void>(resolve=>{release=resolve;});
  network.mockClear().mockImplementation(async(input,init)=>{
    const url=new URL(String(input));expect(url.origin).toBe('https://api-m.sandbox.paypal.com');
    if(url.pathname==='/v1/oauth2/token')return Response.json({access_token:'synthetic',token_type:'Bearer',expires_in:3600});
    expect(url.pathname).toBe(`/v2/checkout/orders/${order}`);expect(init?.method).toBe('GET');entered=true;await delayed;
    return Response.json({id:order,status:'COMPLETED',intent:'CAPTURE',purchase_units:[{custom_id:f.intent.id,amount:{currency_code:'USD',value:'1.00'},payments:{captures:[{id:capture,status:'COMPLETED',amount:{currency_code:'USD',value:'1.00'}}]}}]});
  });
  const restarted=await buildHostedApp({...config,paypal:{...config.paypal,webhookId:'SYNTHETICWEBHOOK'}},{schema,staticFiles:false,maintenance:()=>closed});
  try{
    await restarted.listen({host:'127.0.0.1',port:0});
    await expect.poll(()=>entered,{timeout:2500,interval:25}).toBe(true);
    closed=true;expect((await restarted.inject({url:'/api/release/status'})).json()).toMatchObject({maintenance:true,quiescent:false,activeRequests:1});
    release();await expect.poll(async()=>(await inbox.getEvent(event.id))?.state,{timeout:2500,interval:25}).toBe('processed');
    await expect.poll(async()=>(await restarted.inject({url:'/api/release/status'})).json().quiescent,{timeout:2500,interval:25}).toBe(true);
    expect((await inbox.getEvent(event.id))?.process_attempts).toBe(2);expect((await store.byOrder(order)).attempt.state).toBe('captured');
    expect(network).toHaveBeenCalledTimes(2);
    expect((await admin.query(`SELECT count(*)::int n FROM ${schema}.webhook_deliveries WHERE claimed_event_id=$1`,[event.id])).rows[0].n).toBe(1);
  }finally{release();await restarted.close();network.mockImplementation(async()=>{throw Error('Unexpected provider network call');});}
});
