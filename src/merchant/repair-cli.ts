/** Local-only CLI. No environment/config loader, provider client, server or network imports. */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Store } from '../db/store.ts';
import { RepairService } from './repair.ts';
const original=fileURLToPath(new URL('../../.work/ordertruth.sqlite',import.meta.url));
export function isolatedDatabase(path:string):string {
 const target=realpathSync(resolve(path));
 if(existsSync(original)){
  const source=realpathSync(original), a=statSync(source,{bigint:true}), b=statSync(target,{bigint:true});
  if(target.toLowerCase()===source.toLowerCase()||(a.dev===b.dev&&a.ino===b.ino))throw Error('original v3 database is protected; use an isolated demo/test copy');
 }
 if(!statSync(target).isFile())throw Error('database must be an existing isolated file');return target;
}
async function main(){
 const {values:v,positionals}=parseArgs({allowPositionals:true,options:{db:{type:'string'},org:{type:'string'},incident:{type:'string'},requester:{type:'string'},plan:{type:'string'},'plan-sha256':{type:'string'},operator:{type:'string'}}});
 const required=(key:keyof typeof v)=>{const value=v[key];if(!value)throw Error(`--${key} required`);return value;};
 const command=positionals[0];
 if(positionals.length!==1||!['plan','show','approve','execute','history'].includes(command??''))throw Error('usage: pnpm repair plan|show|approve|execute|history --db <isolated.sqlite> --org <organization> ...');
 // Refuse a noninteractive approval BEFORE opening/migrating even a copy.
 if(command==='approve'&&(!process.stdin.isTTY||!process.stdout.isTTY))throw Error('approval requires interactive input and output TTY');
 const path=isolatedDatabase(required('db'));
 const store=new Store(path);
 try{
  const service=new RepairService(store,required('org'));
  let result:unknown;
  switch(command){
   case 'plan':result=service.plan(required('incident'),required('requester'));break;
   case 'show':result=service.getPlan(required('plan'));break;
   case 'history':result=service.history(required('incident'));break;
   case 'approve':await service.approveInteractive(required('plan'),required('plan-sha256'),required('operator'));result={approved:true,identityAssurance:'LOCAL_DEMO_DECLARED_OPERATOR',authentication:'NONE'};break;
   case 'execute':{
    const outcome=service.execute(required('plan'));
    result=outcome;
    if(outcome.outcome!=='SUCCEEDED')process.exitCode=3;
    break;
   }
  }
  console.log(JSON.stringify(result,null,2));
 }finally{store.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch((error:unknown)=>{console.error(`repair command refused: ${error instanceof Error ? error.message : 'unknown local failure'}. No approval was inferred.`);process.exitCode=2;});
