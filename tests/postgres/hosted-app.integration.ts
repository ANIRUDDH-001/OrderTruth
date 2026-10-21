import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { afterAll,beforeAll,expect,it,vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPostgresPool } from "../../src/db/postgres.ts";
import { loadPostgresConfig } from "../../src/config.ts";
import { buildHostedApp } from "../../src/server/hosted-app.ts";
const env = parseEnv(readFileSync(new URL("../../.work/postgres/.env",import.meta.url),"utf8"));
if (env.PGHOST !== "127.0.0.1" || env.PGPORT !== "55432" || env.PGDATABASE !== "ordertruth") throw new Error("Managed local PostgreSQL only");
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
  expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
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
  expect((await app.inject({ method: "POST",url: "/api/orders",headers: { origin,cookie,"x-checkout-key": "synthetic-checkout-key" },payload: {} })).statusCode).toBe(403);
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
