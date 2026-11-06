/** Offline configuration/entrypoint tests. Never opens a provider client, database or .env. */
import { describe, expect, it, vi } from "vitest";
import { createApprovalBoundIntake, bootstrapBudgetPath, bootstrapSourceIdentity, openApprovedBootstrap, parseBootstrapCommand, requireApprovedAction, validateBootstrapApproval, validateRecordedPayeePreflight } from "../src/merchant/lab-reference-bootstrap.ts";
import { createLabSandboxClient, isLabSandboxClient } from "../src/merchant/lab-sandbox-client.ts";

const now = Date.parse("2026-11-05T10:00:00Z"), digest="a".repeat(64);
const config = () => ({ version:1,authorization:"OWNER_APPROVED_G2_SANDBOX",runId:"0123456789abcdef",approvedSourceSha256:digest,
  approvedAt:"2026-11-05T09:00:00Z",expiresAt:"2026-11-05T11:00:00Z",merchantId:"reference-merchant",payeeMerchantId:"PAYEEMERCHANT1",
  webhookId:"WHREGISTERED123",tunnelWebhookUrl:"https://owner-approved.example/webhooks/paypal",port:3008,
  approvedActions:["initialize","listen","create-order","capture-approved-order","invoke-return","replay-webhook"],
  amountMinor:100,currency:"USD",maximumSpendINR:0,registrationMode:"reuse",recordedPayeePreflight:{path:".work/preflight.json",sha256:"b".repeat(64)} });

describe("manual isolated Sandbox bootstrap configuration",()=>{
  it("expired owner approval blocks ingress before signature or provider work",async()=>{
    const at=Date.now(),clock=vi.spyOn(Date,"now").mockReturnValue(at);
    const approval=validateBootstrapApproval({...config(),approvedAt:new Date(at-1000).toISOString(),expiresAt:new Date(at+1000).toISOString()},digest,at);
    let calls=0;const intake=createApprovalBoundIntake(approval,{receive:async()=>{calls++;return {status:200,body:{ok:true}};}});
    try {
      expect((await intake.receive(Buffer.from("{}"),{},"offline")).status).toBe(200);
      clock.mockReturnValue(at+1001);
      await expect(intake.receive(Buffer.from("{}"),{},"offline-expired")).rejects.toThrow("expired");
      expect(calls).toBe(1);
    }finally{clock.mockRestore();}
  });
  it("requires explicit execution and approval artifact; no implicit default action",()=>{
    expect(()=>parseBootstrapCommand([])).toThrow("explicit");
    expect(()=>parseBootstrapCommand(["--action","session","--approval",".work/approval.json"])).toThrow("explicit");
    expect(parseBootstrapCommand(["--action","session","--approval",".work/approval.json","--execute"])).toEqual({action:"session",approvalPath:".work/approval.json",execute:true});
    expect(parseBootstrapCommand(["--source-identity"])).toEqual({action:"source-identity",execute:false});
  });
  it("refuses duplicate/unknown options and arbitrary action strings",()=>{
    for(const args of [["--execute","--execute"],["--fetch","x"],["--action","capture","--approval","x","--execute"],["--approval","x","--approval","y","--execute"]])expect(()=>parseBootstrapCommand(args)).toThrow();
  });
  it("validates an exact source-bound, time-bounded one-dollar zero-cost approval",()=>{
    const approved=validateBootstrapApproval(config(),digest,now);
    expect(approved.amountMinor).toBe(100);expect(approved.maximumSpendINR).toBe(0);expect(Object.isFrozen(approved)).toBe(true);
  });
  it("rejects source drift, expiration, future approval and long-lived approval",()=>{
    expect(()=>validateBootstrapApproval(config(),"c".repeat(64),now)).toThrow("source");
    expect(()=>validateBootstrapApproval({...config(),expiresAt:"2026-11-05T09:30:00Z"},digest,now)).toThrow("expired");
    expect(()=>validateBootstrapApproval({...config(),approvedAt:"2026-11-05T10:30:00Z"},digest,now)).toThrow("future");
    expect(()=>validateBootstrapApproval({...config(),expiresAt:"2026-11-07T11:00:00Z"},digest,now)).toThrow("24h");
  });
  it("rejects injected provider/fetch/API base, live registration mutation and amount changes",()=>{
    for(const change of [{provider:{}},{fetch:()=>{}},{apiBase:"https://api-m.paypal.com"},{registrationMode:"temporary"},{amountMinor:200},{maximumSpendINR:1}])expect(()=>validateBootstrapApproval({...config(),...change},digest,now)).toThrow();
  });
  it("requires one exact HTTPS endpoint without embedded credentials or query tokens",()=>{
    for(const url of ["http://owner-approved.example/webhooks/paypal","https://localhost/webhooks/paypal","https://user:pass@example.com/webhooks/paypal","https://owner-approved.example/capture","https://owner-approved.example/webhooks/paypal?secret=x"])
      expect(()=>validateBootstrapApproval({...config(),tunnelWebhookUrl:url},digest,now)).toThrow("endpoint");
  });
  it("rejects synthetic identities and duplicate action grants",()=>{
    expect(()=>validateBootstrapApproval({...config(),payeeMerchantId:"SYN-PAYEE"},digest,now)).toThrow("real reference");
    expect(()=>validateBootstrapApproval({...config(),approvedActions:["initialize","initialize"]},digest,now)).toThrow("duplicate");
  });
  it("requires exact action authorization even after approval parsing",()=>{
    const a=validateBootstrapApproval({...config(),approvedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),approvedActions:["initialize"]},digest);
    expect(()=>requireApprovedAction(a,"initialize")).not.toThrow();expect(()=>requireApprovedAction(a,"create-order")).toThrow("action approval");
  });
  it("preflights recorded merchant_id shape without substituting an email",()=>{
    const raw={provenance:"OFFLINE_RECORDED_MOCK",readback:{purchase_units:[{payee:{merchant_id:"PAYEEMERCHANT1"}}]}};
    expect(validateRecordedPayeePreflight(raw,"PAYEEMERCHANT1")).toEqual({provenance:"OFFLINE_RECORDED_MOCK",eligible:true});
    expect(()=>validateRecordedPayeePreflight({...raw,readback:{purchase_units:[{payee:{email_address:"seller@example.com"}}]}},"PAYEEMERCHANT1")).toThrow("preflight");
    expect(()=>validateRecordedPayeePreflight(raw,"ANOTHERPAYEE1")).toThrow("preflight");
  });
  it("preflight input cannot claim genuine authority or omit its expected shape",()=>{
    expect(()=>validateRecordedPayeePreflight({provenance:"PAYPAL_READBACK",readback:{}},"PAYEEMERCHANT1")).toThrow();
    expect(()=>validateRecordedPayeePreflight({provenance:"OFFLINE_RECORDED_MOCK",readback:{}},"PAYEEMERCHANT1")).toThrow("preflight");
  });
  it("fails before filesystem/environment/provider work if execute approval is missing",async()=>{
    await expect(openApprovedBootstrap("this-root-does-not-exist",{action:"session",execute:false})).rejects.toThrow("execute approval");
  });
  it("source identity omits G3/private holdout inputs and binds the executable G2 sources",()=>{
    const source=bootstrapSourceIdentity(process.cwd());
    expect(source.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(source.manifest.some(row=>row.path==="scripts/lab-reference-sandbox.ts")).toBe(true);
    expect(source.manifest.some(row=>/ai\/|holdout/i.test(row.path))).toBe(false);
  });
  it("uses a budget journal path accepted by the constrained native client without making a request",()=>{
    const path=bootstrapBudgetPath(".work/bootstrap-construction-test");
    expect(path.endsWith(".jsonl")).toBe(true);
    const client=createLabSandboxClient({clientId:"offline-construction-test",clientSecret:"offline-construction-not-a-real-credential"},{budgetFile:path,registrationMode:"reuse"});
    expect(isLabSandboxClient(client)).toBe(true);expect(client.budgetSnapshot().total).toBe(0);expect(client.requestEvidence()).toHaveLength(0);
  });
});
