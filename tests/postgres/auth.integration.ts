import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import Fastify from "fastify";
import { createPostgresPool } from "../../src/db/postgres.ts";
import { migratePostgres } from "../../src/db/postgres-migrate.ts";
import { createSessionAuth } from "../../src/server/auth.ts";
import { registerSessionApi } from "../../src/server/session-api.ts";
import { registerJudgeApi } from "../../src/server/judge-api.ts";
import { PostgresCheckoutStore } from "../../src/db/postgres-checkout.ts";
import { PostgresScenarioStore } from "../../src/merchant/postgres-scenarios.ts";
import { attestNetwork,NETWORK_PROOF_HEADER } from "../../src/server/network-attribution.ts";

import { env } from "./local-db.ts";
const schema = `qual_${randomBytes(10).toString("hex")}`;
const pool = createPostgresPool(env.DATABASE_URL!);
pool.options.options += ` -c search_path=${schema},pg_catalog`;
const origin = "http://127.0.0.1:3333";
const secret = randomBytes(32).toString("hex");
let auth: ReturnType<typeof createSessionAuth>;
let authFailure: unknown = null;
const app = Fastify({ logger: false });
beforeAll(async () => {
  await migratePostgres(pool, schema); auth = createSessionAuth(pool, origin, secret); const original = auth.handler;
  auth.handler = async request => { try { return await original(request); } catch (error) {
    const e = error as Error & { code?: string; cause?: { code?: string } };
    authFailure = { name: e.name, code: e.code ?? null, causeCode: e.cause?.code ?? null, frames: e.stack?.split("\n").slice(1,4).map(line=>line.replace(/C:.*?node_modules/, "node_modules")) }; throw error;
  } }; registerSessionApi(app, auth, origin);
  registerJudgeApi(app, { pool,schema,auth,origin,sourceAttemptId: null }); await app.ready();
});
afterAll(async () => { await app.close(); await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });
// Each test owns this disposable schema. Keep the global admission window
// isolated between tests; restart/concurrency assertions remain within a test.
beforeEach(async () => { await pool.query(`DELETE FROM ${schema}.ot_auth_rate_limit`); });
async function guest(ip: string) {
  const response = await app.inject({ method: "POST", url: "/api/auth/sign-in/anonymous", headers: { origin, "content-type": "application/json" }, payload: {}, remoteAddress: ip });
  expect({status:response.statusCode,authFailure}).toEqual({status:200,authFailure:null});
  const cookies = response.cookies.map(c => `${c.name}=${c.value}`).join("; ");
  expect(cookies.length).toBeGreaterThan(30);
  expect(response.cookies.every(c => c.httpOnly && c.sameSite === "Lax")).toBe(true);
  return cookies;
}
it("creates independent database-backed guest sessions and ignores forged identity headers", async () => {
  const a = await guest("192.0.2.1"); const b = await guest("192.0.2.2");
  const first = (await app.inject({ url: "/api/session", headers: { cookie: a, "x-organization-id": "org_owner", "x-owner": "true" } })).json();
  const second = (await app.inject({ url: "/api/session", headers: { cookie: b } })).json();
  expect(first.authenticated).toBe(true); expect(first.anonymous).toBe(true); expect(first.owner).toBe(false);
  expect(first.userId).not.toBe(second.userId);
  expect(first.token).toBeUndefined(); expect(first.session).toBeUndefined();
  const session = (await pool.query(`SELECT id FROM ${schema}.ot_auth_session WHERE "userId"=$1`, [first.userId])).rows[0];
  expect((await pool.query(`SELECT "ipAddress" FROM ${schema}.ot_auth_session WHERE id=$1`,[session.id])).rows[0].ipAddress).toBe("192.0.2.1");
  await pool.query(`UPDATE ${schema}.ot_auth_session SET "expiresAt"=now()-interval '1 second' WHERE id=$1`, [session.id]);
  expect((await app.inject({ url: "/api/session", headers: { cookie: a } })).json().authenticated).toBe(false);
  expect((await app.inject({ url: "/api/session", headers: { cookie: b } })).json().authenticated).toBe(true);
});
it("denies missing/foreign origins and disables public account registration", async () => {
  for (const headers of [{}, { origin: "https://foreign.invalid" }]) expect((await app.inject({ method: "POST", url: "/api/auth/sign-in/anonymous", headers, payload: {} })).statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: "/api/auth/sign-up/email", headers: { origin }, payload: {} })).statusCode).toBe(404);
  expect((await app.inject({ url: "/api/session", headers: { cookie: "better-auth.session_token=forged" } })).json().authenticated).toBe(false);
});
it("admits independent guests behind one proxy, bounds new identities globally across restart, and reuses existing guests", async () => {
  const cookie = await guest("192.0.2.40");
  const restarted = Fastify({ logger: false });
  registerSessionApi(restarted, createSessionAuth(pool, origin, secret), origin);
  try {
    expect((await restarted.inject({ url: "/api/session", headers: { cookie } })).json().authenticated).toBe(true);
    // Thirty new guests may enter even behind one proxy. A different peer or
    // forged forwarding headers cannot reset the durable GLOBAL budget.
    for (let i = 0; i < 29; i++) expect((await restarted.inject({ method: "POST", url: "/api/auth/sign-in/anonymous", headers: { origin,
      "x-ordertruth-client-ip": `192.0.2.${100+i}`,"x-forwarded-for": `192.0.2.${100+i}`,forwarded: `for=192.0.2.${100+i}`,
    }, payload: {}, remoteAddress: "192.0.2.40" })).statusCode).toBe(200);
    const before = (await pool.query(`SELECT count(*)::int AS n FROM ${schema}.ot_auth_user`)).rows[0].n;
    const denied = await app.inject({ method: "POST", url: "/api/auth/sign-in/anonymous", headers: { origin,"x-ordertruth-client-ip": "203.0.113.9" }, payload: {}, remoteAddress: "192.0.2.99" });
    expect(denied.statusCode).toBe(429);expect(denied.headers["x-retry-after"]).toBeDefined();
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.ot_auth_user`)).rows[0].n).toBe(before);
    const reused = await restarted.inject({ method: "POST",url: "/api/auth/sign-in/anonymous",headers: { origin,cookie },payload: {} });
    expect(reused.statusCode).toBe(200);expect(reused.json()).toEqual({ok:true});expect(reused.cookies).toHaveLength(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.ot_auth_user`)).rows[0].n).toBe(before);
    expect((await restarted.inject({ method: "POST", url: "/api/auth/sign-out", headers: { origin, cookie }, payload: {}, remoteAddress: "192.0.2.41" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/session", headers: { cookie } })).json().authenticated).toBe(false);
    await pool.query(`UPDATE ${schema}.ot_auth_rate_limit SET "lastRequest"=floor(extract(epoch FROM statement_timestamp())*1000)::bigint-61000 WHERE "key"='ordertruth:guest-admission:v1'`);
    expect((await restarted.inject({method:"POST",url:"/api/auth/sign-in/anonymous",headers:{origin},remoteAddress:"192.0.2.98",payload:{}})).statusCode).toBe(200);
    expect((await pool.query(`SELECT "count" FROM ${schema}.ot_auth_rate_limit WHERE "key"='ordertruth:guest-admission:v1'`)).rows[0].count).toBe(1);
  } finally { await restarted.close(); }
});
it("preserves the owner email sign-in limit and ignores forged peer headers",async () => {
  for (let i=0;i<5;i++) expect((await app.inject({ method:"POST",url:"/api/auth/sign-in/email",headers:{origin,"x-ordertruth-client-ip":`203.0.113.${i+1}`,"x-forwarded-for":`203.0.113.${i+1}`},remoteAddress:"192.0.2.77",payload:{email:"missing-owner@example.test",password:"synthetic-wrong-password"} })).statusCode).toBe(401);
  expect((await app.inject({method:"POST",url:"/api/auth/sign-in/email",headers:{origin},remoteAddress:"192.0.2.77",payload:{email:"missing-owner@example.test",password:"synthetic-wrong-password"}})).statusCode).toBe(429);
});
it("shares network admission among independent guests while preserving other networks and restored sessions",async()=>{
  const key = randomBytes(32).toString("hex");
  const ingress = Fastify({ logger: false });
  registerSessionApi(ingress,createSessionAuth(pool,origin,secret),origin,new Set(),key);
  const url = "/api/auth/sign-in/anonymous";
  const enter = (ip: string, cookie?: string) => ingress.inject({ method:"POST",url,payload:{},headers:{ origin,
    ...(cookie ? { cookie } : { [NETWORK_PROOF_HEADER]:attestNetwork(key,ip,url)! }),"x-forwarded-for":"203.0.113.100" } });
  try {
    expect((await ingress.inject({method:"POST",url,payload:{},headers:{origin,"x-real-ip":"192.0.2.33",[NETWORK_PROOF_HEADER]:"forged"}})).json().code).toBe("GUEST_ATTRIBUTION_UNAVAILABLE");
    const attempts = await Promise.all(Array.from({length:16},()=>enter("192.0.2.33")));
    expect(attempts.filter(r => r.statusCode===200)).toHaveLength(12);
    expect(attempts.filter(r => r.statusCode===429)).toHaveLength(4);
    const first = attempts.find(r => r.statusCode===200)!;
    const cookies = first.cookies.map(c=>`${c.name}=${c.value}`).join("; ");
    const restored = await enter("192.0.2.33",cookies);
    expect(restored.statusCode).toBe(200);
    expect(restored.cookies).toHaveLength(0);
    expect((await enter("198.51.100.44")).statusCode).toBe(200);
    const total = (await pool.query(`SELECT "count" FROM ${schema}.ot_auth_rate_limit WHERE "key"='ordertruth:guest-admission:v1'`)).rows[0].count;
    expect(total).toBe(13);
  } finally { await ingress.close(); }
});
it("enforces the global new-guest bound under concurrent requests across authentication instances",async()=>{
  const restarted=Fastify({logger:false});registerSessionApi(restarted,createSessionAuth(pool,origin,secret),origin);
  try {
    const responses=await Promise.all(Array.from({length:36},(_,i)=>(i%2?app:restarted).inject({method:"POST",url:"/api/auth/sign-in/anonymous",headers:{origin,"x-forwarded-for":`203.0.113.${i+1}`},remoteAddress:`192.0.2.${i+100}`,payload:{}})));
    expect(responses.filter(r=>r.statusCode===200)).toHaveLength(30);
    expect(responses.filter(r=>r.statusCode===429)).toHaveLength(6);
  }finally{await restarted.close();}
});
it("runs detection, explicit browser approval and verified repair through real guest sessions", async () => {
  const cookie = await guest("192.0.2.61"); const foreign = await guest("192.0.2.62");
  const identity = (await app.inject({ url: "/api/session",headers: { cookie } })).json();
  const suffix = randomBytes(8).toString("hex").toUpperCase();
  const checkout = new PostgresCheckoutStore(pool,schema);
  const { intent,attempt } = await checkout.createCheckout(`synthetic-judge-api-${suffix}`);
  await checkout.attachOrder(attempt.id,`ORDER${suffix}`);
  await checkout.recordReadback(attempt.id,{ id: `ORDER${suffix}`,status: "COMPLETED",intent: "CAPTURE",purchase_units: [{ custom_id: intent.id,amount: { currency_code: "USD",value: "1.00" },payments: { captures: [{ id: `CAPTURE${suffix}`,status: "COMPLETED",amount: { currency_code: "USD",value: "1.00" } }] } }] },"SYNTHETIC_QUALIFICATION");
  // Synthetic source admitted only through the test-only store method. The
  // public creation route still requires a configured genuine observation.
  const run = await new PostgresScenarioStore(pool,schema).createQualification(identity.userId,attempt.id);
  const path = `/api/scenarios/${run.id}`;
  const post = (action: string,payload: Record<string,unknown> = {},activeCookie = cookie,activeOrigin = origin) => app.inject({ method: "POST",url: `${path}/${action}`,headers: { cookie: activeCookie,origin: activeOrigin },payload });
  const noSourceKey = randomUUID();
  const noSource = await app.inject({ method: "POST",url: "/api/scenarios",headers: { cookie,origin },payload: { operationId: noSourceKey } });
  expect(noSource.statusCode).toBe(503); expect(noSource.json()).toMatchObject({ outcome: "REJECTED",code: "SOURCE_UNAVAILABLE" });
  expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.scenario_operations WHERE operation_id=$1`,[noSourceKey])).rows[0].n).toBe(0);
  expect((await post("duplicate",{},foreign)).statusCode).toBe(404);
  expect((await post("duplicate",{},cookie,"https://foreign.invalid")).statusCode).toBe(403);
  expect((await post("duplicate",{ organizationId: "org_owner" })).statusCode).toBe(400);
  expect((await post("duplicate")).statusCode).toBe(200);
  expect((await post("check")).json().result).toBe("VIOLATED");
  const unavailable = (await post("investigate")).json();
  expect(unavailable.status).toBe("UNAVAILABLE"); expect(unavailable.freshModelExecution).toBe(false);
  expect(unavailable.baseline.kind).toBe("RULES_BASED");
  expect((await post("diagnostics",{ kind: "IDEMPOTENCY_KEYS" })).json().facts.distinctKeys).toBe(2);
  expect((await post("diagnostics",{ kind: "REFUND_PAYMENT" })).statusCode).toBe(400);
  const planned = await post("plan"); expect(planned.statusCode).toBe(200); const plan = planned.json();
  expect((await post("approve",{ planId: plan.id,planSha256: "0".repeat(64) })).statusCode).toBe(409);
  expect((await post("approve",{ planId: plan.id,planSha256: plan.plan_sha256 })).statusCode).toBe(200);
  expect((await post("approve",{ planId: plan.id,planSha256: plan.plan_sha256 })).statusCode).toBe(200);
  const approval = (await pool.query(`SELECT approval_mode,identity_assurance,session_user_id FROM ${schema}.repair_approvals WHERE plan_id=$1`, [plan.id])).rows[0];
  expect(approval).toEqual({ approval_mode: "BROWSER_SESSION",identity_assurance: "SESSION_AUTHENTICATED",session_user_id: identity.userId });
  const executed = await post("execute",{ planId: plan.id }); expect(executed.json().outcome).toBe("SUCCEEDED");
  expect((await post("execute",{ planId: plan.id })).json()).toEqual(executed.json());
  const receipt = await app.inject({ url: `${path}/receipts/${plan.id}`,headers: { cookie } });
  expect(receipt.json().verifiedCurrent).toBe(true);
  await pool.query(`INSERT INTO ${schema}.demo_action_budgets(key,used) VALUES($1,250) ON CONFLICT(key) DO UPDATE SET used=250`, [`run:${run.id}`]);
  expect((await post("check")).statusCode).toBe(429);
  expect((await app.inject({ url: `${path}/receipts/${plan.id}`,headers: { cookie } })).json().verifiedCurrent).toBe(true);
  expect((await app.inject({ url: `${path}/receipts/${plan.id}`,headers: { cookie: foreign } })).statusCode).toBe(404);
});
