import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { reviewedStaticSha } from "./regressions.ts";
import { sourceSha, type Admission } from "./interpreter.ts";
/** Test-only execution, exact pinned SHA admission, no caller-selected executable or script. */
export function runActualReviewedSmoke(source:string,admission:Admission) {
  const sha=sourceSha(source);
  if(process.env.NODE_ENV!=="test")return{status:"NOT_TESTED",reason:"TEST_ONLY"};
  if(sha!==admission.reviewedSha256||!/^[A-Za-z0-9_-]{1,80}$/.test(admission.reviewer)||!Object.values(reviewedStaticSha).includes(sha))return{status:"UNSCORABLE",reason:"EXACT_REVIEWED_SHA_REQUIRED"};
  const runner=fileURLToPath(new URL("./actual-smoke-child.mjs",import.meta.url));
  const result=spawnSync(process.execPath,["--permission",`--allow-fs-read=${runner}`,"--no-addons","--disable-proto=throw","--max-old-space-size=64",runner],{
    input:JSON.stringify({source,reviewedSha256:sha}),encoding:"utf8",timeout:3000,maxBuffer:64000,windowsHide:true,
    env:{NODE_ENV:"test"},
  });
  if(result.error||result.status!==0)return{status:"FAILED",reason:result.error?.name??`CHILD_EXIT_${result.status}`,stderr:result.stderr.slice(0,1200)};
  try{return JSON.parse(result.stdout) as {status:"ACTUAL_REVIEWED_JAVASCRIPT_SMOKE";reviewedSha256:string;passed:number;failed:number;checks:string[];scope:string};}
  catch{return{status:"FAILED",reason:"INVALID_CHILD_OUTPUT"};}
}
