/** OFFLINE SESSION ORCHESTRATION: real session/checkout/SQLite/budget, mocked native factory/runtime/socket.
 * No production injection seam, actual PayPal request or genuine evidence claim. */
import {randomBytes} from "node:crypto";
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync,realpathSync,rmSync} from "node:fs";
import {dirname,join,resolve,relative,sep} from "node:path";
import {afterEach,describe,it,expect,vi} from "vitest";
import {FakePayPal} from "./fake-paypal.ts";
import {createOfflineLabSandboxClientForTest,type LabSandboxClient} from "../src/merchant/lab-sandbox-client.ts";
import {openApprovedBootstrap,bootstrapSourceIdentity,sha256} from "../src/merchant/lab-reference-bootstrap.ts";
const mocked=vi.hoisted(()=>({transport:null as null|((url:string,init:RequestInit)=>Promise<Response>),clients:[] as unknown[]}));
vi.mock("../src/merchant/lab-sandbox-client.ts",async original=>{
 const actual=await original<typeof import("../src/merchant/lab-sandbox-client.ts")>();
 return {...actual,createLabSandboxClient:vi.fn((credentials,options)=>{
  if(!mocked.transport)throw Error("offline fixture missing");
  const client=actual.createOfflineLabSandboxClientForTest(credentials,options,mocked.transport);mocked.clients.push(client);return client;
 }),getLabSandboxPayPalClient:vi.fn(client=>client)};
});
vi.mock("../src/merchant/lab-reference-runtime.ts",async original=>({
 ...await original<typeof import("../src/merchant/lab-reference-runtime.ts")>(),
 createReferenceRuntime:vi.fn(async()=>({close:async()=>{},knownEvent:async()=>null,returnFor:async()=>{throw Error("not used");},webhook:async()=>{throw Error("not used");}})),
 registerReferenceIntent:vi.fn(async()=>{}),
}));
vi.mock("../src/webhooks/app.ts",()=>({buildWebhookApp:vi.fn(async()=>({listen:async()=>{},close:async()=>{}}))}));
type Run=Exclude<Awaited<ReturnType<typeof openApprovedBootstrap>>,{initialized:true}>;
const base=resolve(".work/runs/g2-preapproval-payee-20261105/session-fixtures");
const roots:string[]=[],sessions:Run[]=[];
afterEach(async()=>{
 for(const s of sessions.splice(0))await s.close();
 mocked.transport=null;mocked.clients=[];
 for(const root of roots.splice(0)){const path=resolve(root),rel=relative(base,path);if(!rel||rel.startsWith("..")||!path.startsWith(base+sep))throw Error("refusing unsafe test cleanup");rmSync(path,{recursive:true,force:true});}
});
async function setup(mode="correct"){
 mkdirSync(base,{recursive:true});const root=realpathSync(mkdtempSync(join(base,"case-")));roots.push(root);
 const id=bootstrapSourceIdentity(process.cwd());for(const row of id.manifest){const dest=join(root,row.path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(row.path));}
 mkdirSync(join(root,".work"),{recursive:true});
 const runId=randomBytes(8).toString("hex"),source=bootstrapSourceIdentity(root).sourceSha256;
 const preflight=JSON.stringify({provenance:"OFFLINE_RECORDED_MOCK",readback:{purchase_units:[{payee:{merchant_id:"MERCHANTFAKE123"}}]}});
 writeFileSync(join(root,".work/preflight.json"),preflight);
 const approval={version:1,authorization:"OWNER_APPROVED_G2_SANDBOX",runId,approvedSourceSha256:source,approvedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),merchantId:"offline-merchant",payeeMerchantId:"MERCHANTFAKE123",webhookId:"OFFLINEREG123",tunnelWebhookUrl:"https://offline.example/webhooks/paypal",port:3008,approvedActions:["listen","create-order","capture-approved-order"],amountMinor:100,currency:"USD",maximumSpendINR:0,registrationMode:"reuse",recordedPayeePreflight:{path:".work/preflight.json",sha256:sha256(preflight)}};
 writeFileSync(join(root,".work/approval.json"),JSON.stringify(approval));
 writeFileSync(join(root,".env"),["PAYPAL_ENV=sandbox","PAYPAL_API_BASE=https://api-m.sandbox.paypal.com","PAYPAL_CLIENT_ID=offline-test-client","PAYPAL_CLIENT_SECRET=offline-test-no-provider-secret","LAB_PG_ADMIN_URL=postgres://offline:offline-test@127.0.0.1:59999/postgres",`LAB_CAPABILITY_KEY_CROSS_PATH=${"11".repeat(32)}`,`LAB_CAPABILITY_KEY_CORRECTED=${"22".repeat(32)}`,""].join("\n"));
 const runBase=join(root,`.work/lab-reference/${runId}`);mkdirSync(runBase,{recursive:true});
 writeFileSync(join(runBase,"ready.json"),JSON.stringify({runId,source,merchant:approval.merchantId,payee:approval.payeeMerchantId,webhook:approval.webhookId,url:approval.tunnelWebhookUrl}));
 const fake=new FakePayPal();fake.webhookRegistrations.set(approval.webhookId,{url:approval.tunnelWebhookUrl,event_types:[{name:"PAYMENT.CAPTURE.COMPLETED"},{name:"CHECKOUT.ORDER.APPROVED"}]});
 const requests:Array<{method:string;path:string}>=[],trace:string[]=[];
 let release=()=>{},started=()=>{};
 const getStarted=new Promise<void>(r=>{started=r;}),gate=new Promise<void>(r=>{release=r;});
 mocked.transport=async(url,init)=>{
  const path=new URL(url).pathname,method=init.method??"GET";requests.push({method,path});
  if(method==="POST"&&path==="/v2/checkout/orders"){
   trace.push("CREATE_POST");
   if(mode==="uncertain-create"){await fake.fetch(url,init);throw new TypeError("offline lost create response");}
  }
  const isGet=method==="GET"&&/^\/v2\/checkout\/orders\//.test(path);
  if(isGet){trace.push("GET_STARTED");started();if(mode==="delayed")await gate;if(mode==="get-error")throw new TypeError("offline GET failure");}
  const response=await fake.fetch(url,init);
  if(isGet&&response.ok){const body=await response.json();
   if(mode==="wrong")body.purchase_units[0].payee.merchant_id="OTHER";
   if(mode==="missing")delete body.purchase_units[0].payee;
   if(mode==="id-mismatch")body.id="WRONGORDER";
   trace.push("GET_FINISHED");return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});
  }return response;
 };
 async function start(){const run=await openApprovedBootstrap(root,{action:"session",approvalPath:".work/approval.json",execute:true});if(run.initialized)throw Error("unexpected initialization");sessions.push(run);return run;}
 const run=await start();
 const count=(method:string,pattern:RegExp)=>requests.filter(r=>r.method===method&&pattern.test(r.path)).length;
 return {run,start,root,runBase,fake,trace,getStarted,release:()=>release(),count,stop:async(current:Run)=>{const i=sessions.indexOf(current);if(i>=0)sessions.splice(i,1);await current.close();},client:()=>mocked.clients.at(-1) as LabSandboxClient};
}
describe("pre-approval payee gate through actual session commands, OFFLINE",()=>{
 it("withholds approval URL until counted provider GET finishes and verifies expected order/payee",async()=>{
  const f=await setup("delayed");let returned=false;
  const pending=f.run.command("create-order").then(result=>{returned=true;f.trace.push("URL_RELEASED");return result as {approveUrl:string;orderId:string};});
  await f.getStarted;expect(returned).toBe(false);expect(existsSync(join(f.runBase,"pre-approval-payee-readback.json"))).toBe(false);
  f.release();const result=await pending;
  expect(result.approveUrl).toContain(result.orderId);expect(f.trace).toEqual(["CREATE_POST","GET_STARTED","GET_FINISHED","URL_RELEASED"]);
  expect(f.client().budgetSnapshot().counts.getOrder).toBe(1);
  const receipt=JSON.parse(readFileSync(join(f.runBase,"pre-approval-payee-readback.json"),"utf8"));expect(receipt).toMatchObject({orderId:result.orderId,payeeMerchantId:"MERCHANTFAKE123",provenance:"PAYPAL_ORDER_READBACK_PRE_APPROVAL"});
 });
 it.each(["wrong","missing","get-error","id-mismatch"])("%s: URL withheld and capture blocked, including after restart",async mode=>{
  const f=await setup(mode);await expect(f.run.command("create-order")).rejects.toThrow();
  expect(existsSync(join(f.runBase,"pre-approval-payee-readback.json"))).toBe(false);
  const orderId=[...f.fake.orders.keys()][0]!;f.fake.approve(orderId);
  await expect(f.run.command("capture-approved-order BUYER_APPROVED")).rejects.toThrow("pre-approval");
  const spent=f.client().budgetSnapshot();await f.stop(f.run);const restarted=await f.start();
  expect(f.client().budgetSnapshot()).toEqual(spent);
  await expect(restarted.command("create-order")).rejects.toThrow("purchase already exists");
  await expect(restarted.command("capture-approved-order BUYER_APPROVED")).rejects.toThrow("pre-approval");
  expect(f.count("POST",/^\/v2\/checkout\/orders$/)).toBe(1);expect(f.count("POST",/\/capture$/)).toBe(0);
 });
 it("exhausted GET budget refuses before any create/preflight outbound call, and persists on restart",async()=>{
  const f=await setup();for(let i=0;i<12;i++)await f.client().getOrder("UNKNOWN",{correlationId:"offline-fill"}).catch(()=>{});
  const spent=f.client().budgetSnapshot();await expect(f.run.command("create-order")).rejects.toThrow("budget unavailable");
  expect(f.count("POST",/^\/v2\/checkout\/orders$/)).toBe(0);expect(f.count("GET",/^\/v2\/checkout\/orders\//)).toBe(12);
  await f.stop(f.run);const restarted=await f.start();expect(f.client().budgetSnapshot()).toEqual(spent);
  await expect(restarted.command("create-order")).rejects.toThrow("budget unavailable");expect(f.count("POST",/\/capture$/)).toBe(0);
 });
 it("uncertain create outcome retains its claim and never silently creates another order",async()=>{
  const f=await setup("uncertain-create");await expect(f.run.command("create-order")).rejects.toThrow();
  await f.stop(f.run);const restarted=await f.start();await expect(restarted.command("create-order")).rejects.toThrow("purchase already exists");
  await expect(restarted.command("capture-approved-order BUYER_APPROVED")).rejects.toThrow();
  expect(f.count("POST",/^\/v2\/checkout\/orders$/)).toBe(1);expect(f.fake.orders.size).toBe(1);expect(f.count("POST",/\/capture$/)).toBe(0);
 });
 it("successful preflight survives restart and permits only the existing single purchase capture",async()=>{
  const f=await setup();const result=await f.run.command("create-order") as {orderId:string};f.fake.approve(result.orderId);
  await f.stop(f.run);const restarted=await f.start();await expect(restarted.command("create-order")).rejects.toThrow("purchase already exists");
  expect(await restarted.command("capture-approved-order BUYER_APPROVED")).toMatchObject({state:"captured"});
  await expect(restarted.command("capture-approved-order BUYER_APPROVED")).rejects.toThrow("already attempted");
  expect(f.count("POST",/^\/v2\/checkout\/orders$/)).toBe(1);expect(f.count("POST",/\/capture$/)).toBe(1);
 });
});
