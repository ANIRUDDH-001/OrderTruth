import {createHash} from "node:crypto";
import {describe,it,expect} from "vitest";
import {createReferenceWorkflow} from "../src/merchant/lab-reference-workflow.ts";
function setup(state:string, transient=0){
 const raw=Buffer.from(JSON.stringify({id:"WH-TERMINAL0001",event_type:"PAYMENT.CAPTURE.COMPLETED"}));
 let verified=false,postbacks=0,writes=0;
 const hash=createHash("sha256").update(raw).digest("hex");
 const deps={intake:{receive:async()=>{postbacks++;verified=true;return {status:200,body:{ok:true,result:"accepted" as const}};}},
 processor:{drain:async()=>0},runtime:{knownEvent:async(_id:string,h:string)=>verified&&h===hash?{state}:null,
 webhook:async()=>{writes++;if(writes<=transient)throw new Error("transient");return {outcome:"ignored"};},returnFor:async()=>({outcome:"ignored"})}};
 const workflow=createReferenceWorkflow(deps as unknown as Parameters<typeof createReferenceWorkflow>[0]);
 return {raw,workflow,counts:()=>({postbacks,writes})};
}
describe("reference terminal postback control",()=>{
 for(const state of ["disagreed","foreign","ignored","failed"])it(`${state}: six deliveries need one postback`,async()=>{
  const f=setup(state);for(let i=0;i<6;i++)expect((await f.workflow.receive(f.raw,{},"offline")).status).toBe(200);
  expect(f.counts().postbacks).toBe(1);
 });
 it("processed event retries transient local failure without repeated postbacks",async()=>{
  const f=setup("processed",2);
  expect((await f.workflow.receive(f.raw,{},"offline")).status).toBe(503);
  expect((await f.workflow.receive(f.raw,{},"offline")).status).toBe(503);
  expect((await f.workflow.receive(f.raw,{},"offline")).status).toBe(200);
  expect(f.counts()).toEqual({postbacks:1,writes:3});
 });
 it("changed bytes for a known event require another signature verification",async()=>{
  const f=setup("ignored");await f.workflow.receive(f.raw,{},"offline");
  await f.workflow.receive(Buffer.from(f.raw.toString()+" "),{},"offline");expect(f.counts().postbacks).toBe(2);
 });
});
