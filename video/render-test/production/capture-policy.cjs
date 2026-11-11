'use strict';
const assert=require('node:assert/strict');
const CASE='run_0ddc4e8b-f040-4ad7-8ea2-098f8beeae95',KEEP='mo_bf9bb97b-495c-473f-9905-1627b85dec99',VOID='mo_fbf7e14b-8ebf-4b49-8385-0857ff21f04e';
const ORIGIN='https://order-truth.vercel.app',BASE='/api/scenarios/'+CASE;
const TOKENS={plan:'PREPARE_FRESH_PLAN',approve:'APPROVE_EXACT_PLAN',execute:'EXECUTE_EXACT_PLAN'};
function validateCase(s,repaired=false){
 assert.equal(s?.run?.id,CASE);assert.equal(s.run.label,'CONTROLLED_MERCHANT_SCENARIO');
 assert.equal(s.paymentReference?.provenance,'PAYPAL_SANDBOX_GET');assert.equal(s.paymentReference?.recordedCapture?.status,'COMPLETED');
 assert.deepEqual(s.orders.map(o=>o.id).sort(),[KEEP,VOID].sort());
 assert.deepEqual(s.orders.filter(o=>o.effective_status==='placed').map(o=>o.id).sort(),repaired?[KEEP]:[KEEP,VOID].sort());
 if(repaired)assert.equal(s.orders.find(o=>o.id===VOID).effective_status,'voided_duplicate');
}
function validatePlan(s,config,now=Date.now()){
 validateCase(s);const p=s.latestPlan;assert(p);assert.equal(p.keep_order_id,KEEP);assert.deepEqual(JSON.parse(p.void_order_ids_json),[VOID]);
 assert(/^[a-zA-Z0-9_-]{1,100}$/.test(p.id));assert(/^[a-f0-9]{64}$/.test(p.plan_sha256));assert(Date.parse(p.expires_at)>now+10000);assert.equal(p.has_receipt,false);
 if(config.stage!=='plan'){assert.equal(p.id,config.planId);assert.equal(p.plan_sha256,config.planSha256);assert.equal(p.approved,config.stage==='execute');}
 return {id:p.id,sha256:p.plan_sha256,keep:KEEP,voids:[VOID],expiresAt:p.expires_at};
}
function validReceipt(r){return !!(r?.verifiedCurrent===true&&r.receipt?.outcome==='SUCCEEDED'&&/^[a-zA-Z0-9_-]{1,100}$/.test(r.receipt.execution_id)&&r.current?.activeOrders===1&&r.current.matchingKeeper===1&&r.current.providerUnchanged===true&&/^[a-f0-9]{64}$/.test(r.receipt.provider_before_sha256)&&r.receipt.provider_before_sha256===r.receipt.provider_after_sha256);}
function configFromEnv(e){const c={stage:e.CAPTURE_STAGE,authorization:e.OWNER_AUTHORIZATION,planId:e.REVIEWED_PLAN_ID,planSha256:e.REVIEWED_PLAN_SHA256};assert.equal(c.authorization,TOKENS[c.stage]);assert(Object.hasOwn(TOKENS,c.stage));if(c.stage!=='plan'){assert(/^[a-zA-Z0-9_-]{1,100}$/.test(c.planId||''));assert(/^[a-f0-9]{64}$/.test(c.planSha256||''));}return c;}
function validateSession(state){
 assert(Array.isArray(state?.cookies)&&state.cookies.length>0&&Array.isArray(state.origins));
 assert.deepEqual(Object.keys(state).sort(),['cookies','origins']);
 for(const c of state.cookies){assert(['order-truth.vercel.app','ordertruth.onrender.com'].includes(c.domain));assert.equal(c.secure,true);assert.equal(c.httpOnly,true);assert(typeof c.name==='string'&&typeof c.value==='string');}
 for(const o of state.origins){assert([ORIGIN,'https://ordertruth.onrender.com'].includes(o.origin));assert(Array.isArray(o.localStorage));assert.equal(o.localStorage.length,0,'No local-storage secrets accepted');}
}
function makePolicy(config){let armed=false,used=false;return {
 arm(){assert(!used);armed=true;},
 allow(url,method,body,scenario){
  let u;try{u=new URL(url);}catch{return false;}
  if(![ORIGIN,'https://ordertruth.onrender.com'].includes(u.origin)||u.username||u.password)return false;
  const p=u.pathname;
  if(['GET','HEAD'].includes(method)){
   if(p.startsWith('/api/'))return p==='/api/session'||p===BASE||p===BASE+'/investigation'||p===BASE+'/autopilot/trace'||(config.planId&&p===BASE+'/receipts/'+config.planId);
   return u.origin===ORIGIN;
  }
  if(method!=='POST'||!armed||used||p!==BASE+'/'+config.stage||u.search||!body||Array.isArray(body))return false;
  try{validateCase(scenario);if(config.stage!=='plan')validatePlan(scenario,config);else assert(!scenario.latestPlan||Date.parse(scenario.latestPlan.expires_at)<=Date.now());}catch{return false;}
  const expected=config.stage==='plan'?{}:config.stage==='approve'?{planId:config.planId,planSha256:config.planSha256}:{planId:config.planId};
  try{assert.deepEqual(body,expected);}catch{return false;}
  used=true;armed=false;return true;
 },get used(){return used;}
};}
// Public metadata is constructed from primitives only; never serialize responses, errors or storage state.
function publicCapture(i){
 const shots={};for(const scene of ['S09','S10'])if(i.shots?.[scene]){assert(i.shots[scene].every(r=>Array.isArray(r)&&r.length===2&&r.every(Number.isFinite)&&r[0]>=0&&r[1]>=r[0]));shots[scene]=i.shots[scene].map(r=>[...r]);}
 const p=i.reviewedPlan,r=i.receipt,v=i.mp4Verified;
 if(p){assert(/^[a-zA-Z0-9_-]{1,100}$/.test(p.id)&&/^[a-f0-9]{64}$/.test(p.sha256));assert.equal(p.keep,KEEP);assert.deepEqual(p.voids,[VOID]);assert(Number.isFinite(Date.parse(p.expiresAt)));}
 if(r)assert(/^[a-zA-Z0-9_-]{1,100}$/.test(r.id)&&r.planId===p?.id);
 if(i.sourceSha256)assert(/^[a-f0-9]{64}$/.test(i.sourceSha256));
 const events=(i.events||[]).map(e=>{assert(['repair-executed','receipt-reopened'].includes(e.type)&&Number.isFinite(e.start)&&Number.isFinite(e.end)&&e.end>=e.start);assert.equal(e.receiptId,r?.id);return {type:e.type,start:e.start,end:e.end,caseId:CASE,receiptId:r.id,keeperId:KEEP,duplicateId:VOID,verifiedCurrent:true,...(e.type==='receipt-reopened'?{afterReload:true}:{})};});
 return {schemaVersion:1,stage:Object.hasOwn(TOKENS,i.stage)?i.stage:null,caseId:CASE,complete:i.complete===true,aiRequestCap:0,aiResponses:[],shots,events,reviewedPlan:p?{id:p.id,sha256:p.sha256,keep:KEEP,voids:[VOID],expiresAt:p.expiresAt}:null,receipt:r?{id:r.id,planId:r.planId,verifiedCurrent:r.verifiedCurrent===true,reopened:r.reopened===true,activeOrders:1,matchingKeeper:1,providerUnchanged:r.providerUnchanged===true}:null,recordingMp4:i.recordingMp4==='continuation.mp4'?'continuation.mp4':null,sourceSha256:i.sourceSha256||null,mp4Verified:v?{codec:'h264',width:1920,height:1080,fps:30,duration:Number(v.duration),fullDecode:v.fullDecode===true}:null,status:i.complete?'STAGE_COMPLETE':'STOPPED_REQUIRES_RECONCILIATION'};
}
module.exports={CASE,KEEP,VOID,ORIGIN,BASE,TOKENS,validateCase,validatePlan,validReceipt,validateSession,configFromEnv,makePolicy,publicCapture};
