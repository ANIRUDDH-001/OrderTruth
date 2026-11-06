/** Owner-operated, isolated G2 bootstrap. Importing this module performs no I/O or provider action. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import pg from "pg";
import { z } from "zod";
import { CheckoutService, type Logger } from "../checkout-service.ts";
import { loadConfig } from "../config.ts";
import { Store } from "../db/store.ts";
import type { WebhookIntake } from "../webhooks/intake.ts";
import { buildWebhookApp } from "../webhooks/app.ts";
import { assembleWebhookService } from "../webhooks/runtime.ts";
import { createReferenceRuntime, initializeReferenceStore, registerReferenceIntent, type ReferenceConfig } from "./lab-reference-runtime.ts";
import { createReferenceWorkflow } from "./lab-reference-workflow.ts";
import { preflightPayee } from "./lab-payee-preflight.ts";
import { createLabSandboxClient, getLabSandboxPayPalClient } from "./lab-sandbox-client.ts";
import type { OrderReadback } from "../domain/checkout.ts";

const SHA = /^[a-f0-9]{64}$/;
const ACTIONS = ["initialize", "listen", "create-order", "capture-approved-order", "invoke-return", "replay-webhook"] as const;
export const approvalSchema = z.strictObject({
  version: z.literal(1), authorization: z.literal("OWNER_APPROVED_G2_SANDBOX"),
  runId: z.string().regex(/^[a-f0-9]{16}$/), approvedSourceSha256: z.string().regex(SHA),
  approvedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  merchantId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), payeeMerchantId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  webhookId: z.string().regex(/^[A-Za-z0-9]{1,50}$/), tunnelWebhookUrl: z.string().max(300),
  port: z.number().int().min(1024).max(65535),
  approvedActions: z.array(z.enum(ACTIONS)).min(1).max(ACTIONS.length),
  amountMinor: z.literal(100), currency: z.literal("USD"), maximumSpendINR: z.literal(0),
  registrationMode: z.literal("reuse"),
  recordedPayeePreflight: z.strictObject({ path: z.string().max(250), sha256: z.string().regex(SHA) }),
});
export type BootstrapApproval = z.infer<typeof approvalSchema>;
export type BootstrapCommand = { action: "initialize" | "session" | "source-identity"; approvalPath?: string; execute: boolean };
export const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function parseBootstrapCommand(args: readonly string[]): BootstrapCommand {
  if (args.length === 1 && args[0] === "--source-identity") return { action: "source-identity", execute: false };
  const values = new Map<string,string>(); let execute = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--execute") { if (execute) throw new Error("duplicate execute flag"); execute = true; continue; }
    if (!["--action", "--approval"].includes(arg) || values.has(arg) || !args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error("invalid bootstrap arguments");
    values.set(arg,args[++i]!);
  }
  const action = values.get("--action"), approvalPath = values.get("--approval");
  if (!execute || !approvalPath || (action !== "initialize" && action !== "session")) throw new Error("explicit --execute, --approval and --action initialize|session required");
  return { action, approvalPath, execute };
}
export function validateBootstrapApproval(raw: unknown, currentSourceSha256: string, nowMs = Date.now()): BootstrapApproval {
  const approval = approvalSchema.parse(raw);
  const start = Date.parse(approval.approvedAt), end = Date.parse(approval.expiresAt);
  if (!SHA.test(currentSourceSha256) || currentSourceSha256 !== approval.approvedSourceSha256) throw new Error("approved bootstrap source identity differs");
  if (start > nowMs || end <= nowMs || end <= start || end - start > 24 * 3600_000) throw new Error("approval expired, future or longer than 24h");
  const url = new URL(approval.tunnelWebhookUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/webhooks/paypal"
    || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("approved HTTPS webhook endpoint required");
  if ([approval.merchantId,approval.payeeMerchantId].some(value => value.startsWith("SYN-"))) throw new Error("real reference identities required");
  if (new Set(approval.approvedActions).size !== approval.approvedActions.length) throw new Error("duplicate approved action");
  return Object.freeze(approval);
}
export function requireApprovedAction(approval: BootstrapApproval, action: typeof ACTIONS[number]) {
  if (Date.parse(approval.expiresAt) <= Date.now() || !approval.approvedActions.includes(action)) throw new Error("owner action approval required or expired");
}
/** Re-check the time-bound owner grant before each public ingress request. */
export function createApprovalBoundIntake(approval:BootstrapApproval,intake:Pick<WebhookIntake,"receive">):Pick<WebhookIntake,"receive"> {
  return {receive:async(...args)=>{requireApprovedAction(approval,"listen");return intake.receive(...args);}};
}
export function validateRecordedPayeePreflight(raw: unknown, expectedMerchantId: string) {
  const input = z.strictObject({ provenance: z.literal("OFFLINE_RECORDED_MOCK"), readback: z.unknown() }).parse(raw);
  const verdict = preflightPayee(input.readback as OrderReadback,expectedMerchantId);
  if (!verdict.eligible) throw new Error("recorded payee identity preflight failed");
  return { provenance: "OFFLINE_RECORDED_MOCK" as const, eligible: true as const };
}
function within(root: string, path: string) {
  const absolute = resolve(root,path), rel = relative(root,absolute);
  if (!rel || rel.startsWith("..") || resolve(absolute) === resolve(root)) throw new Error("bootstrap path must remain below project root");
  for (let cursor = absolute; cursor !== root; cursor = dirname(cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error("bootstrap refuses symlink or junction");
  }
  return absolute;
}
function localWorkPath(root: string, path: string) {
  const absolute = within(root,path);
  if (!relative(root,absolute).startsWith(`.work${sep}`)) throw new Error("bootstrap evidence/config must be below .work");
  return absolute;
}
function smallJson(path: string) {
  if (statSync(path).size > 16_384) throw new Error("bootstrap JSON exceeds limit");
  const raw = readFileSync(path);
  return JSON.parse(raw.toString("utf8"));
}
/** No G3/holdout paths are enumerated. This binds the runner and its relevant G2 implementation. */
export function bootstrapSourceIdentity(root: string) {
  const files: string[] = [];
  function walk(rel: string) {
    const path = join(root,rel);
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path,{ withFileTypes:true })) {
      if (entry.isSymbolicLink()) throw new Error("bootstrap source symlink refused");
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child); else if (/\.(ts|sql)$/.test(child)) files.push(child);
    }
  }
  for (const dir of ["src/webhooks", "src/paypal", "src/domain", "src/db", "packages/guard/src", "packages/guard/sql", "packages/lab-merchant/src"]) walk(dir);
  for (const path of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "scripts/lab-reference-sandbox.ts", "src/merchant/lab-reference-bootstrap.ts", "src/merchant/lab-reference-runtime.ts", "src/merchant/lab-reference-workflow.ts", "src/merchant/lab-sandbox-client.ts", "src/merchant/lab-payee-preflight.ts", "src/merchant/lab-webhook-adapter.ts", "src/merchant/lab-webhook-journal.ts", "src/checkout-service.ts", "src/db/store.ts", "src/config.ts", "src/redact.ts"]) files.push(path);
  const manifest = [...new Set(files)].sort().map(path => ({ path,sha256:sha256(readFileSync(join(root,path))) }));
  return { sourceSha256:sha256(JSON.stringify(manifest)), manifest };
}
function readLocalEnvironment(root: string, approval: BootstrapApproval) {
  // This function is reached only by an explicitly executed, source-bound owner run.
  const path = within(root,".env");
  if (statSync(path).size > 32_768) throw new Error("local environment exceeds bootstrap limit");
  const raw = readFileSync(path);
  const env = parseEnv(raw.toString("utf8"));
  if (env.PAYPAL_ENV !== "sandbox" || env.PAYPAL_API_BASE !== "https://api-m.sandbox.paypal.com") throw new Error("explicit Sandbox environment required");
  const pgUrl = new URL(env.LAB_PG_ADMIN_URL ?? "");
  if (!new Set(["127.0.0.1", "localhost"]).has(pgUrl.hostname) || !new Set(["postgres:","postgresql:"]).has(pgUrl.protocol)
    || pgUrl.pathname !== "/postgres" || !pgUrl.username || !pgUrl.password || pgUrl.search || pgUrl.hash) throw new Error("dedicated local postgres admin endpoint required");
  for (const name of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]) if (!env[name]?.trim()) throw new Error(`local ${name} required`);
  for (const name of ["LAB_CAPABILITY_KEY_CROSS_PATH", "LAB_CAPABILITY_KEY_CORRECTED"]) if (!/^[a-f0-9]{64}$/.test(env[name] ?? "")) throw new Error(`local ${name} requires 32-byte hex key`);
  if (env.LAB_CAPABILITY_KEY_CROSS_PATH === env.LAB_CAPABILITY_KEY_CORRECTED) throw new Error("reference stores require distinct capability keys");
  const cfg = loadConfig({ PAYPAL_ENV:"sandbox",PAYPAL_API_BASE:"https://api-m.sandbox.paypal.com",PAYPAL_CLIENT_ID:env.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET:env.PAYPAL_CLIENT_SECRET,PAYPAL_WEBHOOK_ID:approval.webhookId,AI_PROVIDER:"disabled",WEBHOOK_PORT:String(approval.port),PORT:String(approval.port === 3001 ? 3002 : 3001) });
  return { cfg, pgConfig:{ host:pgUrl.hostname,port:Number(pgUrl.port || "5432"),user:decodeURIComponent(pgUrl.username),password:decodeURIComponent(pgUrl.password),database:"postgres",connectionTimeoutMillis:5000,statement_timeout:10000 },
    keys:{ "cross-path":Buffer.from(env.LAB_CAPABILITY_KEY_CROSS_PATH!,"hex"),corrected:Buffer.from(env.LAB_CAPABILITY_KEY_CORRECTED!,"hex") } };
}
const silent: Logger = { info:()=>{},warn:()=>{},error:()=>{} };
const identityFor = (a: BootstrapApproval) => ({ runId:a.runId,source:a.approvedSourceSha256,merchant:a.merchantId,payee:a.payeeMerchantId,webhook:a.webhookId,url:a.tunnelWebhookUrl });
const databaseFor = (a: BootstrapApproval, variant: ReferenceConfig["variant"]) => `otg_${a.runId}${variant === "cross-path" ? "000a" : "000b"}`;
export const bootstrapBudgetPath = (base: string) => join(base,"provider-budget.jsonl");

/** Executes no provider action for initialize. session is explicitly owner-driven via local stdin. */
export async function openApprovedBootstrap(rootInput: string, command: BootstrapCommand) {
  if (!command.execute || !command.approvalPath || command.action === "source-identity") throw new Error("execute approval required");
  const root = realpathSync(rootInput);
  const current = bootstrapSourceIdentity(root);
  const approval = validateBootstrapApproval(smallJson(localWorkPath(root,command.approvalPath)),current.sourceSha256);
  const preflightPath = localWorkPath(root,approval.recordedPayeePreflight.path);
  if (statSync(preflightPath).size > 16_384) throw new Error("recorded preflight exceeds limit");
  if (sha256(readFileSync(preflightPath)) !== approval.recordedPayeePreflight.sha256) throw new Error("recorded preflight identity differs");
  validateRecordedPayeePreflight(smallJson(preflightPath),approval.payeeMerchantId);
  const base = localWorkPath(root,`.work/lab-reference/${approval.runId}`);
  const local = readLocalEnvironment(root,approval);
  if (command.action === "initialize") {
    requireApprovedAction(approval,"initialize");
    if (existsSync(base)) throw new Error("bootstrap run directory already exists; refusing overwrite");
    mkdirSync(base,{ recursive:true });
    writeFileSync(join(base,"initializing.json"),JSON.stringify(identityFor(approval)),{ flag:"wx" });
    const admin = new pg.Client(local.pgConfig); await admin.connect();
    try {
      for (const variant of ["cross-path","corrected"] as const) {
        const database = databaseFor(approval,variant);
        if ((await admin.query("SELECT 1 FROM pg_database WHERE datname=$1",[database])).rowCount) throw new Error("bootstrap database already exists; refusing reuse");
      }
      for (const variant of ["cross-path","corrected"] as const) {
        const database = databaseFor(approval,variant); await admin.query(`CREATE DATABASE ${database} TEMPLATE template0 ENCODING 'UTF8'`);
        const pool = new pg.Pool({ ...local.pgConfig,database,max:4 });
        try { await initializeReferenceStore(pool,{ merchantId:approval.merchantId,payeeMerchantId:approval.payeeMerchantId,variant,mode:"sandbox" }); } finally { await pool.end(); }
      }
      const store = new Store(join(base,"proof.sqlite")); store.close();
      writeFileSync(join(base,"ready.json"),JSON.stringify(identityFor(approval)),{ flag:"wx" });
    } finally { await admin.end(); }
    return { initialized:true as const,runId:approval.runId };
  }
  requireApprovedAction(approval,"listen");
  if (JSON.stringify(smallJson(join(base,"ready.json"))) !== JSON.stringify(identityFor(approval))) throw new Error("bootstrap store/source binding differs");
  const lock = join(base,"session.lock");writeFileSync(lock,String(process.pid),{ flag:"wx" });
  const pools: pg.Pool[] = []; const runtimes: Array<Awaited<ReturnType<typeof createReferenceRuntime>>> = [];
  const store = new Store(join(base,"proof.sqlite"));
  let app: Awaited<ReturnType<typeof buildWebhookApp>> | undefined;
  let originalApp: Awaited<ReturnType<typeof buildWebhookApp>> | undefined;
  const close = async () => { if (app) await app.close(); if (originalApp) await originalApp.close(); for (const rt of runtimes) await rt.close(); for (const pool of pools) await pool.end();store.close();if (existsSync(lock)) unlinkSync(lock); };
  try {
    const client = createLabSandboxClient({ clientId:local.cfg.paypal.clientId,clientSecret:local.cfg.paypal.clientSecret },{ budgetFile:bootstrapBudgetPath(base),registrationMode:"reuse" });
    const paypal = getLabSandboxPayPalClient(client);
    const checkout = new CheckoutService(paypal,store,silent,{ secrets:local.cfg.secrets });
    const svc = await assembleWebhookService({ config:local.cfg,store,paypal,checkout,log:silent });originalApp=svc.app;
    const runtimeMap = {} as Record<ReferenceConfig["variant"],Awaited<ReturnType<typeof createReferenceRuntime>>>;
    for (const variant of ["cross-path","corrected"] as const) {
      const database=databaseFor(approval,variant),pool=new pg.Pool({ ...local.pgConfig,database,max:8 }),aux=new pg.Pool({ ...local.pgConfig,database,max:2 });pools.push(pool,aux);
      const auxUrl=`postgres://${encodeURIComponent(local.pgConfig.user)}:${encodeURIComponent(local.pgConfig.password)}@${local.pgConfig.host}:${local.pgConfig.port}/${database}`;
      const rt=await createReferenceRuntime({ pool,aux,auxConnectionString:auxUrl,config:{ merchantId:approval.merchantId,payeeMerchantId:approval.payeeMerchantId,variant,mode:"sandbox" },capabilityKey:local.keys[variant],provider:client,inbox:svc.inbox });
      runtimeMap[variant]=rt;runtimes.push(rt);
    }
    const registrationReceipt=join(base,"registration-readback.json");
    const body=existsSync(registrationReceipt)?smallJson(registrationReceipt):(await paypal.getWebhook(approval.webhookId,{ correlationId:"local-bootstrap-registration" })).body as {id?:unknown;url?:unknown;event_types?:unknown};
    if (body.id!==approval.webhookId || body.url!==approval.tunnelWebhookUrl || !Array.isArray(body.event_types)
      || !["PAYMENT.CAPTURE.COMPLETED","CHECKOUT.ORDER.APPROVED"].every(name=>(body.event_types as Array<{name?:unknown}>).some(type=>type.name===name))) throw new Error("approved registration configuration mismatch");
    if(!existsSync(registrationReceipt))writeFileSync(registrationReceipt,JSON.stringify({id:body.id,url:body.url,event_types:[{name:"PAYMENT.CAPTURE.COMPLETED"},{name:"CHECKOUT.ORDER.APPROVED"}]}),{flag:"wx"});
    const workflow=createReferenceWorkflow({ intake:svc.intake,processor:svc.processor,runtime:runtimeMap["cross-path"] });
    app=await buildWebhookApp({ intake:{receive:async(...args)=>{requireApprovedAction(approval,"listen");return workflow.receive(...args);}},maxBodyBytes:local.cfg.webhook.maxBodyBytes,log:silent,rateLimit:{perMinute:local.cfg.webhookIngress.ratePerMinute,burst:local.cfg.webhookIngress.rateBurst} });
    await app.listen({host:"127.0.0.1",port:approval.port});
    async function singlePurchase() { const list=store.listAttempts();if(list.length!==1 || !list[0]!.paypal_order_id) throw new Error("one created purchase required");return list[0]!; }
    const preApprovalReceipt=join(base,"pre-approval-payee-readback.json");
    const record=(result:unknown)=>writeFileSync(join(base,`invocation-${Date.now()}-${process.hrtime.bigint()}.json`),JSON.stringify(result),{flag:"wx"});
    return { initialized:false as const,runId:approval.runId,close,
      async command(input:string) {
        const [action,variantInput,eventId,...extra]=input.trim().split(/\s+/);
        if(extra.length)throw new Error("unsupported local command");
        if(action==="budget" && !variantInput)return {provenance:"LOCAL_BUDGET",counts:client.budgetSnapshot(),requests:client.requestEvidence()};
        if(action==="events" && !variantInput)return {provenance:"PERSISTED_VERIFIED_INBOX",events:svc.inbox.listEvents().map(e=>({id:e.event_id,type:e.event_type,state:e.state}))};
        if(action==="create-order" && !variantInput) {
          requireApprovedAction(approval,"create-order");if(store.listAttempts().length)throw new Error("purchase already exists; no second purchase");
          const remaining=client.budgetSnapshot();
          if(remaining.counts.getOrder>=12 || remaining.total+2>remaining.maximum)
            throw new Error("pre-approval readback budget unavailable; create refused");
          const created=await checkout.createOrder("local-bootstrap-create",{checkoutKey:`lab-reference-${approval.runId}`});
          // Do not expose the provider approval URL until THIS order's genuine-path
          // counted readback establishes payee identity. The owner mock is schema-only.
          const preApproval=await client.getOrder(created.orderId,{correlationId:"local-bootstrap-before-approval"});
          if(preApproval.body.id!==created.orderId || !preflightPayee(preApproval.body,approval.payeeMerchantId).eligible) {
            record({provenance:"PRE_APPROVAL_PAYEE_READBACK_REFUSED",orderId:created.orderId});
            throw new Error("pre-approval order/payee identity unverifiable; approval URL withheld and capture blocked");
          }
          for (const variant of ["cross-path","corrected"] as const) await registerReferenceIntent(pools[variant==="cross-path"?0:2]!,{merchantId:approval.merchantId,payeeMerchantId:approval.payeeMerchantId,variant,mode:"sandbox"},{intentId:created.intentId,orderId:created.orderId,sku:"OT-GATE0-SANDBOX-TEST",amount:{currency:"USD",minor:100}});
          // Success is durable before URL release. A crash/failure before this receipt
          // leaves the original checkout claim in place and capture fails closed.
          writeFileSync(preApprovalReceipt,JSON.stringify({provenance:"PAYPAL_ORDER_READBACK_PRE_APPROVAL",runId:approval.runId,
            sourceSha256:approval.approvedSourceSha256,orderId:created.orderId,intentId:created.intentId,payeeMerchantId:approval.payeeMerchantId,
            responseSha256:sha256(JSON.stringify(preApproval.body)),debugId:preApproval.debugId,verifiedAt:new Date().toISOString()}),{flag:"wx",mode:0o600,flush:true});
          return { provenance:"OWNER_SANDBOX_CREATE_REQUEST",...created };
        }
        if(action==="capture-approved-order" && variantInput==="BUYER_APPROVED" && !eventId) {
          requireApprovedAction(approval,"capture-approved-order");const attempt=await singlePurchase();
          if(attempt.capture_claims>0)throw new Error("capture already attempted; readback only, no automatic retry");
          if(!existsSync(preApprovalReceipt))throw new Error("successful pre-approval payee readback required; capture blocked");
          const checked=smallJson(preApprovalReceipt);
          if(checked.provenance!=="PAYPAL_ORDER_READBACK_PRE_APPROVAL" || checked.runId!==approval.runId
            || checked.sourceSha256!==approval.approvedSourceSha256 || checked.orderId!==attempt.paypal_order_id
            || checked.intentId!==attempt.intent_id || checked.payeeMerchantId!==approval.payeeMerchantId)
            throw new Error("pre-approval payee receipt differs; capture blocked");
          const before=await client.getOrder(attempt.paypal_order_id!,{correlationId:"local-bootstrap-before-capture"});
          if(!preflightPayee(before.body,approval.payeeMerchantId).eligible)throw new Error("actual order payee identity mismatch; capture refused");
          const result=await checkout.capture(attempt.paypal_order_id!,"local-bootstrap-capture");
          record({provenance:"OWNER_SANDBOX_CAPTURE_REQUEST",result});return {provenance:"OWNER_SANDBOX_CAPTURE_REQUEST",state:result.state,orderId:attempt.paypal_order_id};
        }
        if((action==="invoke-return" || action==="replay-webhook") && (variantInput==="cross-path" || variantInput==="corrected")) {
          requireApprovedAction(approval,action);const attempt=await singlePurchase();
          if(action==="invoke-return" && eventId)throw new Error("unexpected return argument");
          if(action==="replay-webhook" && (!eventId || !/^WH-[A-Za-z0-9-]{6,100}$/.test(eventId)))throw new Error("verified event id required");
          const result=action==="invoke-return"?await runtimeMap[variantInput].returnFor(attempt.intent_id):await runtimeMap[variantInput].webhook(eventId!);
          const receipt={provenance:"LOCAL_BOOTSTRAP_INVOCATION",handler:action,variant:variantInput,result};record(receipt);return receipt;
        }
        throw new Error("unsupported local command or missing explicit confirmation");
      },
    };
  } catch (error) { await close();throw error; }
}
