import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { createPostgresPool } from "../db/postgres.ts";
import { installReleaseBarrier } from "./release-barrier.ts";

/** Maintenance bridge has no business handlers, auth, SDK or migrations. V8 is
 * never run over V9. This process performs only a version SELECT. */
export async function buildMaintenanceApp(databaseUrl:string,schema="ordertruth") {
  if(schema!=="ordertruth" && (process.env.NODE_ENV!=="test" || !/^qual_[a-f0-9]{20}$/.test(schema))) throw new Error("Invalid maintenance schema");
  const pool=createPostgresPool(databaseUrl);
  let schemaVersion:number;
  try{
    schemaVersion=(await pool.query(`SELECT max(version) AS version FROM ${schema}.ordertruth_postgres_migrations`)).rows[0]?.version;
    if(schemaVersion!==8 && schemaVersion!==9) throw new Error("Maintenance requires managed V8 or V9");
  }catch(error){await pool.end();throw error;}
  const app=Fastify({logger:false,genReqId:()=>randomUUID()});
  app.addHook("onClose",async()=>{await pool.end();});
  installReleaseBarrier(app,()=>true);
  app.get("/api/health",async()=>({ok:true,environment:"sandbox",maintenance:true,schemaVersion}));
  app.all("/api/*",async(_request,reply)=>reply.code(503).header("retry-after","30").send({code:"RELEASE_MAINTENANCE",ready:false}));
  return app;
}
