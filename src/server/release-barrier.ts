import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { FastifyInstance } from "fastify";

/** A configured file is fail-closed, including missing/invalid state. Operations
 * atomically replace it with exactly OPEN or CLOSED; no HTTP mutation endpoint.
 * CLOSED must survive restarts. An unset file preserves ordinary local startup. */
export function maintenanceState(env: Record<string,string|undefined>): () => boolean {
  const mode=env.ORDERTRUTH_RELEASE_MODE ?? "normal";
  if (!["normal","maintenance","hold"].includes(mode)) throw new Error("Invalid release mode");
  const path=env.ORDERTRUTH_BARRIER_FILE;
  if(path && !isAbsolute(path)) throw new Error("Release barrier file must be absolute");
  return ()=>{
    if(mode!=="normal") return true;
    if(!path) return false;
    const state=readFileSync(path,"utf8").trim();
    if(state!=="OPEN" && state!=="CLOSED") throw new Error("Invalid release barrier state");
    return state==="CLOSED";
  };
}

/** Process-local drain evidence only. A disconnected/timed-out request is never
 * subtracted until onResponse: uncertainty blocks release rather than granting
 * premature quiescence. This is not proof that another process has stopped. */
export function installReleaseBarrier(app: FastifyInstance,isClosed:()=>boolean,sourceSha?:string) {
  if(sourceSha && !/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("Invalid release source identity");
  const active=new Set<string|symbol>();
  const closed=()=>{try{return isClosed();}catch{return true;}};
  const status=()=>{const maintenance=closed();return {maintenance,activeRequests:active.size,quiescent:maintenance&&active.size===0};};
  app.addHook("onRequest",async(request,reply)=>{
    const route=request.routeOptions.url;
    if(!route?.startsWith("/api/")) return;
    reply.header("cache-control","no-store");
    if(route==="/api/health" || route==="/api/release/status") return;
    if(closed()) return reply.code(503).header("retry-after","30").send({
      error:"Release maintenance; no new request was admitted. Reconcile any earlier uncertain operation after service resumes.",
      code:"RELEASE_MAINTENANCE",ready:false,requestId:request.id,
    });
    if(sourceSha && request.method!=="GET" && request.method!=="HEAD" && route.startsWith("/api/scenarios") && request.headers["x-ordertruth-source"]!==sourceSha)
      return reply.code(409).send({code:"CLIENT_RELEASE_MISMATCH",error:"This browser uses a different release. Reload before acting; saved cases and receipts remain available."});
    active.add(request.id);
  });
  app.addHook("onResponse",async request=>{active.delete(request.id);});
  app.get("/api/release/status",async()=>status());
  app.get("/api/release/identity",async()=>({sourceSha:sourceSha??null,schemaVersion:9,backendContract:"phase1-core-v1"}));
  function enterBackground(){
    if(closed())return null;
    const token=Symbol('background');active.add(token);return ()=>{active.delete(token);};
  }
  return {status,enterBackground};
}
