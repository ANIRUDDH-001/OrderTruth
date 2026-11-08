import {setTimeout as delay} from 'node:timers/promises';

type Options={read?:(url:string)=>Promise<unknown>;now?:()=>number;sleep?:(ms:number)=>Promise<unknown>;timeoutMs?:number};
/** Render's live deploy state can precede routing convergence. Only retry reads;
 * require matching NORMAL readiness on both ingress paths in two full rounds. */
export async function waitForReleaseReadiness(origins:readonly string[],sha:string,options:Options={}){
 const now=options.now??Date.now,sleep=options.sleep??delay,deadline=now()+(options.timeoutMs??150_000);
 const read=options.read??(async(url:string)=>{const r=await fetch(url,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10_000)});if(!r.ok)throw Error('Readiness not ready');return r.json();});
 let stable=0;
 while(now()<deadline){
  let ready=true;
  for(const origin of origins){
   try{
    const identity=await read(origin+'/api/release/identity') as {sourceSha?:string;schemaVersion?:number;backendContract?:string};
    const health=await read(origin+'/api/readiness') as {ready?:boolean;schemaVersion?:number;backendContract?:string};
    if(identity.sourceSha!==sha||identity.schemaVersion!==9||identity.backendContract!=='phase1-core-v1'||health.ready!==true||health.schemaVersion!==9||health.backendContract!=='phase1-core-v1')ready=false;
   }catch{ready=false;}
  }
  stable=ready?stable+1:0;
  if(stable===2)return;
  await sleep(Math.min(5000,Math.max(0,deadline-now())));
 }
 throw Error('Backend routing/readiness did not converge before the bounded deadline');
}
