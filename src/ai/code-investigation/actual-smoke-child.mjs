// Executes only pinned, engineer-reviewed synthetic sources; never arbitrary model code.
import { createHash } from 'node:crypto';
import vm from 'node:vm';
const allowed = new Set(['70c5c981ea2ffdceec9b5cb31868addc31d47ebc2c2e1bdafba3ad70b9617ed4','3780cd851e708101c65705313125950ada399c1879d84db80bbd0dc5a4d47d0a','ec24b0299a352913881d2086689f7a1ffd2483429433eebea1725a1713151b5d','54ed68f4c1fd060e9648535dc35129689163c8175590832251638dbebd511de2']);
let raw='';
for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>16000)throw Error('INPUT_LIMIT');}
const input=JSON.parse(raw);const sha=createHash('sha256').update(input.source).digest('hex');
if(process.env.NODE_ENV!=='test'||sha!==input.reviewedSha256||!allowed.has(sha))throw Error('REVIEW_ADMISSION_REQUIRED');
const context=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
const source=input.source.replaceAll('export ','')+'\nglobalThis.handler = typeof place === "function" ? place : fulfill;';
new vm.Script(source,{filename:'reviewed-smoke'}).runInContext(context,{timeout:100});
const invoke=context.handler;
const make=()=>{const rows=[];let fail=false;return{rows,fail:()=>{fail=true;},audit:()=>{},createOrderOnce(p,path){
  if(rows.length>=32)throw Error('ROW_LIMIT');
  const hits=rows.filter(r=>r.merchantId===p.merchantId&&(r.intentId===p.intentId||r.captureId===p.captureId));
  if(hits.some(r=>['merchantId','intentId','captureId','amountMinor','currency'].some(k=>r[k]!==p[k])))throw Error('IDENTITY_CONFLICT');
  if(hits[0])return hits[0];if(fail){fail=false;throw Error('INJECTED_FAILURE');}
  const row=Object.freeze({...p,id:`o${rows.length+1}`,path});rows.push(row);return row;
}};};
const p={merchantId:'m1',intentId:'i1',captureId:'c1',amountMinor:100,currency:'USD'};
const assert=(ok,name)=>{if(!ok)throw Error(`FAILED:${name}`);};const checks=[];
const db=make();await invoke(db,p,'return');await invoke(db,p,'event');assert(db.rows.length===1,'sequential');checks.push('sequential');
await Promise.all([invoke(db,p,'return'),invoke(db,p,'event')]);assert(db.rows.length===1,'overlap-replay');checks.push('overlap-replay');
await invoke(db,{...p,intentId:'i2',captureId:'c2'},'return');assert(db.rows.length===2,'distinct-purchases');checks.push('distinct-purchases');
for(const changed of [{captureId:'c3'},{intentId:'i3'},{amountMinor:200},{currency:'EUR'}]){let rejected=false;try{await invoke(db,{...p,...changed},'event');}catch(e){rejected=e.message==='IDENTITY_CONFLICT';}assert(rejected,'identity');}checks.push('identity');
await invoke(db,{...p,merchantId:'m2'},'event');assert(db.rows.length===3,'merchant');checks.push('merchant');
const rollback=make();rollback.fail();let rejected=false;try{await invoke(rollback,p,'return');}catch(e){rejected=e.message==='INJECTED_FAILURE';}assert(rejected&&rollback.rows.length===0,'rollback');checks.push('rollback');
await invoke(rollback,p,'retry');assert(rollback.rows.length===1,'retry');checks.push('retry');
process.stdout.write(JSON.stringify({status:'ACTUAL_REVIEWED_JAVASCRIPT_SMOKE',reviewedSha256:sha,passed:checks.length,failed:0,checks,scope:'Pinned synthetic JavaScript functions and in-memory adapter in restricted child; no database/process-crash proof'})+'\n');
