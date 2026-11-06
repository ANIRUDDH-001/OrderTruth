/** OFFLINE ONLY: fake approval/.env in a disposable workspace; initialization makes no provider request. */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapSourceIdentity, openApprovedBootstrap, sha256 } from "../../src/merchant/lab-reference-bootstrap.ts";
import { createLabSandboxClient } from "../../src/merchant/lab-sandbox-client.ts";
import { adminConfig } from "./harness.ts";

vi.mock("../../src/merchant/lab-sandbox-client.ts",async importOriginal=>({
  ...await importOriginal<typeof import("../../src/merchant/lab-sandbox-client.ts")>(),
  createLabSandboxClient:vi.fn(()=>{throw new Error("initialization must never construct a provider client");}),
}));

const base=resolve(".work/runs/g2-g3-v4-20261105/bootstrap-init-fixtures");
const active:Array<{root:string;databases:string[];admin:pg.Client}>=[];
afterEach(async()=>{
  for(const env of active.splice(0)) {
    try {
      for(const name of env.databases) {
        if(!/^otg_[0-9a-f]{20}$/.test(name))throw new Error("refusing non-disposable cleanup");
        await env.admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
    } finally {
      await env.admin.end();
      const target=resolve(env.root),rel=relative(base,target);
      if(!rel || rel.startsWith("..") || !target.startsWith(base+sep))throw new Error("refusing cleanup outside test fixture workspace");
      rmSync(target,{recursive:true,force:true});
    }
  }
});
async function fixture() {
  mkdirSync(base,{recursive:true});
  const root=realpathSync(mkdtempSync(join(base,"fixture-")));
  // Only this explicit G2 source manifest is copied; no G3/private holdout paths are searched.
  const identity=bootstrapSourceIdentity(process.cwd());
  for(const entry of identity.manifest) {
    if(/ai\/|holdout/i.test(entry.path))throw new Error("unexpected evaluation path");
    const target=join(root,entry.path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(entry.path));
  }
  mkdirSync(join(root,".work"),{recursive:true});
  const pgConfig=adminConfig(),admin=new pg.Client(pgConfig);await admin.connect();
  const runId=randomBytes(8).toString("hex");
  const databases=[`otg_${runId}000a`,`otg_${runId}000b`];
  const existed=await admin.query("SELECT datname FROM pg_database WHERE datname=ANY($1::text[])",[databases]);
  if(existed.rowCount) {await admin.end();throw new Error("random test databases already exist; refusing ownership");}
  active.push({root,databases,admin});
  const before=JSON.stringify({provenance:"OFFLINE_RECORDED_MOCK",readback:{purchase_units:[{payee:{merchant_id:"MOCKPAYEE123"}}]}});
  writeFileSync(join(root,".work/preflight.json"),before);
  const approval={version:1,authorization:"OWNER_APPROVED_G2_SANDBOX",runId,approvedSourceSha256:bootstrapSourceIdentity(root).sourceSha256,
    approvedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+120000).toISOString(),
    merchantId:"offline-bootstrap-merchant",payeeMerchantId:"MOCKPAYEE123",webhookId:"OFFLINEREGISTRATION123",
    tunnelWebhookUrl:"https://offline-test.example/webhooks/paypal",port:3008,approvedActions:["initialize"],amountMinor:100,currency:"USD",maximumSpendINR:0,registrationMode:"reuse",
    recordedPayeePreflight:{path:".work/preflight.json",sha256:sha256(before)}};
  writeFileSync(join(root,".work/approval.json"),JSON.stringify(approval));
  const url=`postgresql://${encodeURIComponent(String(pgConfig.user))}:${encodeURIComponent(String(pgConfig.password))}@${pgConfig.host}:${pgConfig.port}/postgres`;
  // Deliberately fake credentials, scoped only to this new offline test workspace.
  writeFileSync(join(root,".env"),[
    "PAYPAL_ENV=sandbox","PAYPAL_API_BASE=https://api-m.sandbox.paypal.com","PAYPAL_CLIENT_ID=offline-test-client","PAYPAL_CLIENT_SECRET=offline-test-not-a-provider-credential",
    `LAB_PG_ADMIN_URL=${url}`,`LAB_CAPABILITY_KEY_CROSS_PATH=${"11".repeat(32)}`,`LAB_CAPABILITY_KEY_CORRECTED=${"22".repeat(32)}`,"",
  ].join("\n"));
  return {root,runId,databases,admin,pgConfig,base:join(root,`.work/lab-reference/${runId}`)};
}

describe("isolated bootstrap initialization with disposable PostgreSQL, no provider",()=>{
  it("creates both reference stores and SQLite proof with zero constructed provider clients",async()=>{
    const f=await fixture();
    const result=await openApprovedBootstrap(f.root,{action:"initialize",approvalPath:".work/approval.json",execute:true});
    expect(result).toEqual({initialized:true,runId:f.runId});
    expect(createLabSandboxClient).not.toHaveBeenCalled();
    expect(existsSync(join(f.base,"ready.json"))).toBe(true);expect(existsSync(join(f.base,"proof.sqlite"))).toBe(true);
    expect(existsSync(join(f.base,"provider-budget.jsonl"))).toBe(false);
    for(const [index,database] of f.databases.entries()) {
      const client=new pg.Client({...f.pgConfig,database});await client.connect();
      try {
        const config=(await client.query("SELECT value FROM lab_reference.config")).rows[0].value;
        expect(config).toMatchObject({merchantId:"offline-bootstrap-merchant",payeeMerchantId:"MOCKPAYEE123",variant:index===0?"cross-path":"corrected",mode:"sandbox"});
        expect((await client.query("SELECT count(*)::int AS n FROM shop.orders")).rows[0].n).toBe(0);
        expect((await client.query("SELECT count(*)::int AS n FROM ordertruth_guard.capture_evidence")).rows[0].n).toBe(0);
        const indexes=(await client.query("SELECT indexname FROM pg_indexes WHERE schemaname='shop' AND indexname LIKE 'reference_%' ORDER BY indexname")).rows.map(row=>row.indexname);
        expect(indexes).toEqual(index===0?[]:["reference_capture_once","reference_intent_once"]);
      } finally {await client.end();}
    }
    const marker=readFileSync(join(f.base,"ready.json"));
    await expect(openApprovedBootstrap(f.root,{action:"initialize",approvalPath:".work/approval.json",execute:true})).rejects.toThrow("already exists");
    expect(readFileSync(join(f.base,"ready.json"))).toEqual(marker);
  });
});
