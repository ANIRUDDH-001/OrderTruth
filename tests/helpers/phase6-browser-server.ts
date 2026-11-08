/** Loopback-only, disposable SYNTHETIC browser qualification. Never loads .env,
 * never issues PayPal/model requests, never seeds the hosted judge database. */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { betterAuth } from "better-auth";
import { createPostgresPool } from "../../src/db/postgres.ts";
import { PostgresCheckoutStore } from "../../src/db/postgres-checkout.ts";
import { PostgresScenarioStore } from "../../src/merchant/postgres-scenarios.ts";
import { buildHostedApp } from "../../src/server/hosted-app.ts";
import { createSessionAuth } from "../../src/server/auth.ts";
import { sessionIdentity } from "../../src/server/session-api.ts";
import { loadPostgresConfig } from "../../src/config.ts";
import { assertLocalDatabase } from "../../scripts/qualification-safety.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Explicit test mode required");
const local = parseEnv(readFileSync(".work/postgres/.env","utf8"));
assertLocalDatabase(local.DATABASE_URL!);
const schema = `qual_${randomBytes(10).toString("hex")}`;
const origin = "http://127.0.0.1:3016";
const config = loadPostgresConfig({ DATABASE_URL: local.DATABASE_URL,APP_ORIGIN: origin,AUTH_SECRET: randomBytes(32).toString("hex"),
  PAYPAL_ENV: "sandbox",PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",PAYPAL_CLIENT_ID: "synthetic-browser-client",PAYPAL_CLIENT_SECRET: "synthetic-browser-secret",AI_PROVIDER: "disabled" });
globalThis.fetch = async () => { throw new Error("Outbound transport forbidden in browser qualification"); };
const app = await buildHostedApp(config,{ schema,staticFiles: true });
const pool = createPostgresPool(local.DATABASE_URL!); pool.options.options += ` -c search_path=${schema},pg_catalog`;
const auth = createSessionAuth(pool,origin,config.authSecret);
// Public synthetic fixture credentials, valid only in this disposable schema.
// Registration is enabled on an unserved bootstrap instance, never HTTP.
const bootstrap = betterAuth({ ...auth.options,emailAndPassword: { ...auth.options.emailAndPassword,enabled: true,disableSignUp: false } });
const owner = await bootstrap.api.signUpEmail({ body: { email: "synthetic-owner@example.test",password: "synthetic-browser-only-password",name: "Synthetic qualification owner" } });
config.ownerIds.add(owner.user.id);
const checkout = new PostgresCheckoutStore(pool,schema);
const { intent,attempt } = await checkout.createCheckout(`synthetic-browser-${randomBytes(8).toString("hex")}`);
await checkout.attachOrder(attempt.id,"SYNTHETICBROWSERORDER");
await checkout.recordReadback(attempt.id,{ id: "SYNTHETICBROWSERORDER",status: "COMPLETED",intent: "CAPTURE",purchase_units: [{ custom_id: intent.id,
  amount: { currency_code: "USD",value: "1.00" },payments: { captures: [{ id: "SYNTHETICBROWSERCAPTURE",status: "COMPLETED",amount: { currency_code: "USD",value: "1.00" } }] },
}] },"SYNTHETIC_QUALIFICATION");
const scenarios = new PostgresScenarioStore(pool,schema);
app.get("/qualification/",async (_request,reply) => reply.type("text/html").send(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Synthetic browser qualification</title><main><h1>Synthetic browser qualification</h1><p>Disposable local PostgreSQL. All payment observations are synthetic. No external inference or payment request can be made.</p><button id="start">Create a synthetic qualification case</button><p id="status" role="status"></p></main><script>
document.querySelector('#start').onclick=async()=>{try{const sign=await fetch('/api/auth/sign-in/anonymous',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});if(!sign.ok)throw Error('Guest sign-in failed');const r=await fetch('/qualification/new-case',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});if(!r.ok)throw Error('Case creation failed');const result=await r.json();location.href='/?run='+encodeURIComponent(result.run);}catch(e){document.querySelector('#status').textContent=e.message;}};
</script></html>`));
app.post("/qualification/new-case",async (request,reply) => {
  if (request.headers.origin !== origin) return reply.code(403).send({ error: "Origin required" });
  const identity = await sessionIdentity(auth,request); if (!identity) return reply.code(401).send({ error: "Session required" });
  const run = await scenarios.createQualification(identity.userId,attempt.id);
  return { run: run.id };
});
let closing = false;
async function close() {
  if (closing) return; closing = true; clearTimeout(timeout);
  await app.close();
  if (!/^qual_[a-f0-9]{20}$/.test(schema)) throw new Error("Invalid disposable schema");
  await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end();
}
const timeout = setTimeout(() => { void close(); },20*60_000);
process.once("SIGINT",() => { void close(); }); process.once("SIGTERM",() => { void close(); });
await app.listen({ host: "127.0.0.1",port: 3016 });
console.log("Synthetic qualification ready at http://127.0.0.1:3016/qualification/ (20 minute bound)");
