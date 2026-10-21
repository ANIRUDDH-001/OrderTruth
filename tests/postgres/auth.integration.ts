import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import Fastify from "fastify";
import { createPostgresPool } from "../../src/db/postgres.ts";
import { migratePostgres } from "../../src/db/postgres-migrate.ts";
import { createSessionAuth } from "../../src/server/auth.ts";
import { registerSessionApi } from "../../src/server/session-api.ts";
import { registerJudgeApi } from "../../src/server/judge-api.ts";
import { PostgresCheckoutStore } from "../../src/db/postgres-checkout.ts";
import { PostgresScenarioStore } from "../../src/merchant/postgres-scenarios.ts";

const env = parseEnv(readFileSync(new URL("../../.work/postgres/.env", import.meta.url), "utf8"));
if (env.PGHOST !== "127.0.0.1" || env.PGPORT !== "55432" || env.PGDATABASE !== "ordertruth") throw new Error("Managed local PostgreSQL only");
const schema = `qual_${randomBytes(10).toString("hex")}`;
const pool = createPostgresPool(env.DATABASE_URL!);
pool.options.options += ` -c search_path=${schema},pg_catalog`;
const origin = "http://127.0.0.1:3333";
const secret = randomBytes(32).toString("hex");
let auth: ReturnType<typeof createSessionAuth>;
const app = Fastify({ logger: false });
beforeAll(async () => {
  await migratePostgres(pool, schema); auth = createSessionAuth(pool, origin, secret); registerSessionApi(app, auth, origin);
  registerJudgeApi(app, { pool,schema,auth,origin,sourceAttemptId: null }); await app.ready();
});
afterAll(async () => { await app.close(); await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });
async function guest(ip: string) {
  const response = await app.inject({ method: "POST", url: "/api/auth/sign-in/anonymous", headers: { origin, "content-type": "application/json" }, payload: {}, remoteAddress: ip });
  expect(response.statusCode).toBe(200);
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
  await pool.query(`UPDATE ${schema}.ot_auth_session SET "expiresAt"=now()-interval '1 second' WHERE id=$1`, [session.id]);
  expect((await app.inject({ url: "/api/session", headers: { cookie: a } })).json().authenticated).toBe(false);
  expect((await app.inject({ url: "/api/session", headers: { cookie: b } })).json().authenticated).toBe(true);
});
it("denies missing/foreign origins and disables public account registration", async () => {
  for (const headers of [{}, { origin: "https://foreign.invalid" }]) expect((await app.inject({ method: "POST", url: "/api/auth/sign-in/anonymous", headers, payload: {} })).statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: "/api/auth/sign-up/email", headers: { origin }, payload: {} })).statusCode).toBe(404);
  expect((await app.inject({ url: "/api/session", headers: { cookie: "better-auth.session_token=forged" } })).json().authenticated).toBe(false);
});
it("retains sessions and sign-in rate limits across a fresh authentication instance", async () => {
  const cookie = await guest("192.0.2.40");
  const restarted = Fastify({ logger: false });
  registerSessionApi(restarted, createSessionAuth(pool, origin, secret), origin);
  try {
    expect((await restarted.inject({ url: "/api/session", headers: { cookie } })).json().authenticated).toBe(true);
    // New cookies/forged IP headers cannot reset the database-backed IP bucket.
    for (let i = 0; i < 4; i++) expect((await restarted.inject({ method: "POST", url: "/api/auth/sign-in/anonymous", headers: { origin, "x-ordertruth-client-ip": `192.0.2.${100+i}` }, payload: {}, remoteAddress: "192.0.2.40" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/sign-in/anonymous", headers: { origin }, payload: {}, remoteAddress: "192.0.2.40" })).statusCode).toBe(429);
    expect((await restarted.inject({ method: "POST", url: "/api/auth/sign-out", headers: { origin, cookie }, payload: {}, remoteAddress: "192.0.2.41" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/session", headers: { cookie } })).json().authenticated).toBe(false);
  } finally { await restarted.close(); }
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
  expect((await app.inject({ method: "POST",url: "/api/scenarios",headers: { cookie,origin },payload: {} })).statusCode).toBe(503);
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
