import Fastify from "fastify";
import { expect,it } from "vitest";
import { installReleaseBarrier,maintenanceState } from "../src/server/release-barrier.ts";

it("blocks every API before auth/body parsing, including direct webhooks; never acknowledges evidence",async () => {
  const app=Fastify(); let closed=true; let calls=0;
  installReleaseBarrier(app,()=>closed);
  app.post("/api/paypal/webhook",async()=>{calls++;return {accepted:true};});
  app.post("/api/scenarios",async()=>{calls++;return {};});
  app.get("/api/session",async()=>{calls++;return {};});
  app.get("/api/readiness",async()=>({ready:true}));
  app.get("/api/health",async()=>({ok:true}));
  try {
    for(const url of ["/api/paypal/webhook","/api/scenarios"]){
      const r=await app.inject({method:"POST",url,payload:"{",headers:{"content-type":"application/json"}});
      expect(r.statusCode).toBe(503);expect(r.headers["retry-after"]).toBe("30");
      expect(r.json().code).toBe("RELEASE_MAINTENANCE");
    }
    expect((await app.inject("/api/session")).statusCode).toBe(503);
    expect((await app.inject("/api/readiness")).json().ready).toBe(false);
    expect((await app.inject("/api/health")).statusCode).toBe(200);expect(calls).toBe(0);
    closed=false;expect((await app.inject({method:"POST",url:"/api/scenarios",payload:{}})).statusCode).toBe(200);expect(calls).toBe(1);
  }finally{await app.close();}
});

it("does not report quiescence while an admitted handler is still running",async()=>{
  const app=Fastify();let closed=false;let finish!:()=>void;let entered!:()=>void;
  const enteredPromise=new Promise<void>(r=>{entered=r;});const pending=new Promise<void>(r=>{finish=r;});
  const barrier=installReleaseBarrier(app,()=>closed);
  app.post("/api/slow",async()=>{entered();await pending;return {};});
  const request=app.inject({method:"POST",url:"/api/slow"});void request.then(()=>{});
  try{await enteredPromise;closed=true;
    expect(barrier.status()).toEqual({maintenance:true,activeRequests:1,quiescent:false});
    expect((await app.inject({method:"POST",url:"/api/slow"})).statusCode).toBe(503);
    finish();await request;
    expect(barrier.status()).toEqual({maintenance:true,activeRequests:0,quiescent:true});
    closed=false;expect(barrier.status().quiescent).toBe(false);
  }finally{finish();await app.close();}
});

it("fails closed if maintenance state cannot be read",async()=>{
  const app=Fastify();installReleaseBarrier(app,()=>{throw new Error("private path");});
  app.get("/api/session",async()=>({}));
  try{const r=await app.inject("/api/session");expect(r.statusCode).toBe(503);expect(r.body).not.toContain("private path");}finally{await app.close();}
});

it("refuses an old browser or mismatched preview before a scenario write",async()=>{
  const app=Fastify();let calls=0;const source="a".repeat(40);
  installReleaseBarrier(app,()=>false,source);app.post("/api/scenarios",async()=>{calls++;return {};});
  try{
    for(const headers of [{},{"x-ordertruth-source":"b".repeat(40)}]) expect((await app.inject({method:"POST",url:"/api/scenarios",headers,payload:{}})).statusCode).toBe(409);
    expect(calls).toBe(0);
    expect((await app.inject({method:"POST",url:"/api/scenarios",headers:{"x-ordertruth-source":source},payload:{}})).statusCode).toBe(200);
  }finally{await app.close();}
});
it("validates release configuration and pins maintenance across restart",()=>{
  expect(maintenanceState({ORDERTRUTH_RELEASE_MODE:"maintenance"})()).toBe(true);
  expect(()=>maintenanceState({ORDERTRUTH_RELEASE_MODE:"typo"})).toThrow();
  expect(()=>maintenanceState({ORDERTRUTH_BARRIER_FILE:"relative"})).toThrow();
});
