/** LOCAL ONLY: credentials stay in the child environment, never argv/output.
 * Snapshot and restore an already-owned disposable DB; never reads root .env. */
import {readFileSync,writeFileSync,mkdirSync,realpathSync} from "node:fs";
import {resolve,join} from "node:path";
import {parseEnv} from "node:util";
import {spawnSync} from "node:child_process";
import {randomBytes,createHash} from "node:crypto";
import {createPostgresPool} from "../src/db/postgres.ts";
import {assertLocalDatabase} from "./qualification-safety.ts";
import {fileURLToPath} from "node:url";
export async function rehearseLocalBackup(schema="ordertruth") {
if(schema!=="ordertruth" && !/^qual_[a-f0-9]{20}$/.test(schema)) throw new Error("Invalid local backup schema");
if(process.env.NODE_ENV!=="test") throw new Error("Local test environment required");
const settings=parseEnv(readFileSync(".work/postgres/.env","utf8"));
assertLocalDatabase(settings.DATABASE_URL!);
const localUrl=new URL(settings.DATABASE_URL!);
if(readFileSync(".work/postgres/managed.json","utf8")!=="ordertruth-local-postgres-v1") throw new Error("Owned database required");
const db=createPostgresPool(settings.DATABASE_URL!);
const restoreName=`ot_restore_${randomBytes(8).toString("hex")}`;
const base=resolve(".work/release-backup");mkdirSync(base,{recursive:true});
const archive=join(base,`${schema}.dump`);const bin=process.env.ORDERTRUTH_PG_BIN??"C:/Program Files/PostgreSQL/18/bin";
const childEnv:NodeJS.ProcessEnv={};
for(const key of ["SystemRoot","WINDIR","PATH","TEMP","TMP"]) if(process.env[key]) childEnv[key]=process.env[key];
Object.assign(childEnv,{PGHOST:localUrl.hostname,PGPORT:localUrl.port,PGUSER:decodeURIComponent(localUrl.username),PGPASSWORD:decodeURIComponent(localUrl.password)});
function command(name:string,args:string[],success=true){
  const r=spawnSync(join(bin,name+(process.platform==="win32"?".exe":"")),args,{env:childEnv,windowsHide:true,timeout:60000,stdio:"ignore"});
  if(r.error || (success ? r.status!==0 : r.status===0)) throw new Error(`Local ${name} did not meet expected exit condition; private output withheld`);
}
async function fingerprint(pool:ReturnType<typeof createPostgresPool>){
  const tables=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",[schema])).rows;
  const result:Record<string,{rows:number;sha256:string}>={};
  for(const {tablename} of tables){
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tablename)) throw new Error("Unexpected identifier");
    const values=(await pool.query(`SELECT to_jsonb(t)::text AS row FROM ${schema}."${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
    result[tablename]={rows:values.length,sha256:createHash("sha256").update(values.map(r=>r.row).join("\n")).digest("hex")};
  }
  const sequences=(await pool.query("SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=$1 ORDER BY sequencename",[schema])).rows;
  const constraints=(await pool.query("SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname,k.conname",[schema])).rows;
  return {tables:result,sequences,constraints};
}
let created=false;
try{
  const identity=(await db.query("SELECT current_setting('data_directory') AS dir,current_database() AS db,current_setting('port') AS port")).rows[0];
  if(realpathSync(identity.dir)!==realpathSync(resolve(".work/postgres/data")) || identity.db!=="ordertruth" || identity.port!=="55432") throw new Error("Local ownership mismatch");
  const before=await fingerprint(db);
  command("pg_dump",["-Fc",`--schema=${schema}`,"--file",archive,"ordertruth"]);
  command("pg_restore",["--list",archive]);
  const corrupt=join(base,"truncated.dump");writeFileSync(corrupt,readFileSync(archive).subarray(0,30));
  command("pg_restore",["--list",corrupt],false);
  await db.query(`CREATE DATABASE ${restoreName}`);created=true;
  command("pg_restore",["--exit-on-error","--single-transaction","--no-owner","--no-privileges","--dbname",restoreName,archive]);
  const url=new URL(settings.DATABASE_URL!);url.pathname=`/${restoreName}`;
  const restored=createPostgresPool(url.href);
  try{
    const after=await fingerprint(restored);
    if(JSON.stringify(before)!==JSON.stringify(after)) throw new Error("Restored rows, sequences or constraints differ");
    const result={scope:"OWNED_LOCAL_DATABASE_ONLY",verifiedAt:new Date().toISOString(),tables:Object.keys(before.tables).length,
      rows:Object.values(before.tables).reduce((n,t)=>n+t.rows,0),rowAndSequenceAndConstraintEquality:true,corruptArchiveRejected:true,
      archiveSha256:createHash("sha256").update(readFileSync(archive)).digest("hex")};
    writeFileSync(join(base,`${schema}-result.json`),JSON.stringify(result,null,2));
    console.log("VERIFIED local backup restored: all table rows, sequences and constraints identical; corrupt archive rejected. Private archive remains ignored.");
    return result;
  }finally{await restored.end();}
}finally{
  if(created) await db.query(`DROP DATABASE ${restoreName}`);
  await db.end();
}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) await rehearseLocalBackup();
