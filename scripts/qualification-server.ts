/** LOCAL TEST HARNESS ONLY. No root .env, owner account, live provider or model. */
import { randomBytes } from 'node:crypto';
import { appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync,unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { localPostgres } from './local-postgres.ts';
import { assertLocalDatabase,requestRecord } from './qualification-safety.ts';

let phase = 'runtime validation';
async function main() {
if (!/^22\./.test(process.versions.node) || Number(process.versions.node.split('.')[1]) < 13) throw new Error('Node >=22.13 <23 required');
if (process.env.NODE_ENV !== 'test') throw new Error('Qualification requires NODE_ENV=test');
const root = resolve('.');
const check = process.argv.includes('--check');
phase = 'owned PostgreSQL identity check';
console.log(localPostgres(check ? 'check' : 'start',root));
const database = parseEnv(readFileSync('.work/postgres/.env','utf8'));
assertLocalDatabase(database.DATABASE_URL!);
if (check) {
  phase = 'owned backend readiness check';
  const runtime = JSON.parse(readFileSync('.work/qualification/runtime.json','utf8')) as { pid: number };
  const health = await fetch('http://127.0.0.1:3003/api/health',{ signal: AbortSignal.timeout(3000) });
  const identity = await fetch('http://127.0.0.1:3003/qualification/identity',{ signal: AbortSignal.timeout(3000) });
  const state = await identity.json() as { pid: number; qualificationOnly: boolean };
  const status = await health.json() as { ok: boolean; environment: string };
  if (!health.ok || !identity.ok || !status.ok || status.environment !== 'sandbox' || state.pid !== runtime.pid || !state.qualificationOnly
    || !health.headers.get('x-request-id')) throw new Error('Owned backend readiness failed');
  console.log('READY: owned V2 backend, request IDs and isolated qualification identity verified on 127.0.0.1:3003');
  process.exit(0);
}
// External calls fail before DNS/HTTP. No real credentials are configured.
globalThis.fetch = async () => { throw new Error('External provider/model network is disabled in local qualification'); };
const { loadPostgresConfig } = await import('../src/config.ts');
const { buildHostedApp } = await import('../src/server/hosted-app.ts');
const { createPostgresPool } = await import('../src/db/postgres.ts');
const { PostgresCheckoutStore } = await import('../src/db/postgres-checkout.ts');
const { PostgresScenarioStore } = await import('../src/merchant/postgres-scenarios.ts');
const origin = 'http://127.0.0.1:3003';
phase = 'local test configuration';
mkdirSync('.work/qualification',{ recursive: true });
const authPath = '.work/qualification/.env';
if (!existsSync(authPath)) writeFileSync(authPath,`AUTH_SECRET=${randomBytes(32).toString('hex')}\n`,{ flag: 'wx',mode: 0o600 });
const auth = parseEnv(readFileSync(authPath,'utf8'));
const config = loadPostgresConfig({ DATABASE_URL: database.DATABASE_URL,AUTH_SECRET: auth.AUTH_SECRET,APP_ORIGIN: origin,PORT: '3003',
  PAYPAL_ENV: 'sandbox',PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',PAYPAL_CLIENT_ID: 'synthetic-qualification-client',
  PAYPAL_CLIENT_SECRET: 'synthetic-qualification-placeholder',AI_PROVIDER: 'disabled',AI_DAILY_LIMIT: '0',AI_USER_DAILY_LIMIT: '0' });
if (!existsSync('dist/judge/index.html') || !existsSync('dist/owner/index.html')) throw new Error('Build frontends before serve: scripts/qualification.ps1 build');
// Avoid migrations if the app port is already owned by another process.
const { createServer } = await import('node:net');
phase = 'loopback port ownership check';
await new Promise<void>((yes,no) => { const probe = createServer(); probe.once('error',no); probe.listen(3003,'127.0.0.1',() => probe.close(() => yes())); });
phase = 'V2 bootstrap and migrations';
const app = await buildHostedApp(config);
const faultPath = '.work/qualification/fault.json';
// Explicit local transport fault after the real handler runs. Never shipped by
// hosted-main and never substitutes successful application/database behavior.
app.addHook('onSend',async (req,reply,payload) => {
  if (!existsSync(faultPath)) return payload;
  const fault = JSON.parse(readFileSync(faultPath,'utf8')) as { method: string; route: string; mode: string };
  if (req.method !== fault.method || req.routeOptions.url !== fault.route) return payload;
  unlinkSync(faultPath); // One response only, no automatic replay.
  if (fault.mode === 'truncate') return '{';
  if (fault.mode === 'not-found') { reply.code(404); return JSON.stringify({error:'Injected local transport read failure'}); }
  if (fault.mode === 'invalid') return JSON.stringify({invalidQualificationResponse:true});
  return payload;
});
const pool = createPostgresPool(database.DATABASE_URL!);
app.addHook('onClose',async () => { await pool.end(); });
app.addHook('onResponse',async (req,reply) => {
  appendFileSync('.work/qualification/requests.jsonl',JSON.stringify({ at: new Date().toISOString(),
    ...requestRecord(req.method,req.routeOptions.url ?? 'unmatched',reply.statusCode,req.id,reply.elapsedTime) })+'\n');
});
app.get('/qualification/identity',async () => ({ pid: process.pid,qualificationOnly: true,providerNetwork: 'DENIED' }));
app.get('/qualification/',async (_req,reply) => reply.type('text/html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Local qualification only</title>
<h1>Synthetic local qualification</h1><p>This separate test harness uses the actual V2 backend, session API and disposable PostgreSQL database.
This setup button creates only labelled synthetic fixtures. Separately authorized historical observations may also be imported for product qualification. No PayPal or AI network call is permitted.</p>
<button id="start">Start local test session and fixture</button><p id="status" role="status"></p>
<script>document.querySelector('#start').onclick=async()=>{const s=document.querySelector('#status');try{
for(const path of ['/api/auth/sign-in/anonymous','/qualification/fixture']){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
if(!r.ok)throw Error('Local setup failed: HTTP '+r.status);const body=await r.json();if(body.runUrl)location.assign(body.runUrl);}
}catch(e){s.textContent=e.message}};</script></html>`));
app.post('/qualification/fixture',async (req,reply) => {
  if (req.headers.origin !== origin || JSON.stringify(req.body) !== '{}') return reply.code(403).send({ error: 'Same-origin empty request required' });
  const session = await app.inject({ url: '/api/session',headers: { cookie: req.headers.cookie ?? '' } });
  const identity = session.json<{ authenticated: boolean; userId?: string; anonymous?: boolean }>();
  if (!identity.authenticated || !identity.anonymous || !identity.userId) return reply.code(403).send({ error: 'Anonymous local test session required' });
  const suffix = randomBytes(8).toString('hex').toUpperCase();
  const store = new PostgresCheckoutStore(pool,'ordertruth');
  const { intent,attempt } = await store.createCheckout(`synthetic-browser-${suffix}`);
  const order = `ORDER${suffix}`;
  await store.attachOrder(attempt.id,order);
  await store.recordReadback(attempt.id,{ id: order,status: 'COMPLETED',intent: 'CAPTURE',purchase_units: [{ custom_id: intent.id,
    amount: { currency_code: 'USD',value: '1.00' },payments: { captures: [{ id: `CAPTURE${suffix}`,status: 'COMPLETED',amount: { currency_code: 'USD',value: '1.00' } }] } }] },'SYNTHETIC_QUALIFICATION');
  const run = await new PostgresScenarioStore(pool,'ordertruth').createQualification(identity.userId,attempt.id);
  return { provenance: 'SYNTHETIC_QUALIFICATION',runUrl: `/?run=${encodeURIComponent(run.id)}` };
});
phase = 'loopback listener';
await app.listen({ host: '127.0.0.1',port: 3003 });
writeFileSync('.work/qualification/runtime.json',JSON.stringify({ pid: process.pid,node: process.version,origin,
  database: { host: '127.0.0.1',port: 55432,name: 'ordertruth',user: 'ordertruth_dev',data: resolve('.work/postgres/data') },
  qualificationOnly: true,providerNetwork: 'DENIED',readyAt: new Date().toISOString() },null,2));
console.log(`READY ${origin}/qualification/ — SYNTHETIC_QUALIFICATION only; request log .work/qualification/requests.jsonl`);
let closing = false;
async function close() { if (closing) return; closing = true; await app.close(); process.exit(0); }
process.once('SIGINT',close); process.once('SIGTERM',close);
// Bounded session: no unattended hours-long server. Restart preserves DB/auth.
setTimeout(() => { void close(); },45*60_000).unref();
}
void main().catch(error => {
  const code = (error as { code?: string }).code;
  console.error(`Local qualification failed during ${phase} (${code === 'EADDRINUSE' ? 'EADDRINUSE' : error instanceof Error ? error.name : 'unknown'}). No provider/model action is permitted. Check the owned runtime and sanitized local logs; credentials are never printed.`);
  process.exitCode = 1;
});
