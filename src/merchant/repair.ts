import { createHash, randomUUID } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { Store } from '../db/store.ts';
import { CONTRACT_ID, evaluateContract, INCIDENT_CLASS, readbackFact, type PaymentFacts } from './contract.ts';
import { MerchantRepo } from './repo.ts';

/** Sorted keys recursively; arrays retain their deliberately defined order. */
export function canonical(v: unknown): string {
 if (v === null || typeof v !== 'object') return JSON.stringify(v);
 if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
 const o=v as Record<string,unknown>;
 return `{${Object.keys(o).sort().map(k=>`${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
export const sha256=(v:string)=>createHash('sha256').update(v).digest('hex');
export type RepairPlan = {
 id:string; organization_id:string; incident_id:string; intent_id:string; contract:string; evaluation_seq:number;
 keep_order_id:string; void_order_ids_json:string; cause_at_plan:string; facts_json:string; facts_sha256:string;
 plan_sha256:string; requester_name:string; created_at:string; expires_at:string;
};
export type Outcome = {execution_id:string; outcome:'SUCCEEDED'|'REJECTED_INTEGRITY'|'REJECTED_APPROVAL'|'REJECTED_EXPIRED'|'REJECTED_STALE'|'FAILED_POSTCONDITION';reasons_json:string;provider_before_sha256:string;provider_after_sha256:string;completed_at:string};
export type Boundary='after_begin'|'after_voids'|'after_postcondition'|'after_rollback'|'before_commit'|'after_commit';
type Options={now?:()=>number;boundary?:(boundary:Boundary)=>void};
const name=(s:string)=>{if(typeof s!=='string'||s.trim().length<1||s.length>100||/[\x00-\x1f\x7f]/.test(s))throw Error('declared name must be 1–100 printable characters');return s.trim();};
const hashPlan=(p:RepairPlan)=>{const {plan_sha256:_,...body}=p;return sha256(canonical(body));};

/** Offline only. Bound organization is local scope, NOT authentication or RBAC. No provider dependency. */
export class RepairService {
 readonly repo:MerchantRepo;
 constructor(readonly store:Store,readonly organizationId:string,private readonly options:Options={}) {
  this.repo=new MerchantRepo(store);
  if(!this.repo.organizationExists(organizationId)) throw Error('organization not found');
 }
 private now(){return this.options.now?.()??Date.now();}
 private at(){return new Date(this.now()).toISOString();}
 private audit(plan:string,event:string,detail:unknown){this.store.db.prepare('INSERT INTO repair_audit(plan_id,event,detail_json,created_at) VALUES(?,?,?,?)').run(plan,event,canonical(detail),this.at());}
 getPlan(id:string):RepairPlan {
  const p=this.store.db.prepare('SELECT * FROM repair_plans WHERE id=? AND organization_id=?').get(id,this.organizationId) as RepairPlan|undefined;
  if(!p)throw Error('plan not found for organization');return p;
 }
 private snapshot(incidentId:string) {
  const incident=this.repo.getIncident(this.organizationId,incidentId);
  if(!incident||incident.incident_class!==INCIDENT_CLASS||incident.contract!==CONTRACT_ID)throw Error('eligible incident not found for organization');
  const intent=this.repo.intentInOrg(this.organizationId,incident.intent_id);if(!intent)throw Error('intent scope mismatch');
  const attempt=this.store.getAttemptByIntentId(intent.id);if(!attempt)throw Error('attempt missing');
  const evidence=this.store.listEvidence(attempt.id);
  const rows=evidence.filter(e=>e.evidence_class==='PAYPAL_API_READBACK') as Array<{seq:number;http_status:number|null;created_at:string;summary_json:string}>;
  const payment:PaymentFacts={intentId:intent.id,intentSku:intent.sku,intentCurrency:intent.currency,intentMinor:intent.amount_minor,
   attemptId:attempt.id,attemptState:attempt.state,paypalOrderId:attempt.paypal_order_id,captureId:attempt.capture_id,captureStatus:attempt.capture_status,
   capturedMinor:attempt.captured_minor,capturedCurrency:attempt.captured_currency,readbacks:rows.map(readbackFact)};
  const orders=this.repo.effectiveOrdersForIntent(this.organizationId,intent.id);
  const evaluation=evaluateContract(payment,orders.map(o=>({id:o.id,status:o.status,effectiveStatus:o.effective_status,attemptId:o.attempt_id,paypalOrderId:o.paypal_order_id,captureId:o.capture_id,sku:o.sku,currency:o.currency,amountMinor:o.amount_minor})));
  const voids=this.store.db.prepare('SELECT v.* FROM merchant_order_voids v JOIN merchant_orders m ON m.id=v.order_id WHERE m.organization_id=? AND m.intent_id=? ORDER BY v.order_id').all(this.organizationId,intent.id);
  const resolution=this.store.db.prepare('SELECT * FROM incident_resolutions WHERE incident_id=?').get(incidentId)??null;
  // Full attempt + full readback metadata hashes exceed the contract minimum, intentionally detecting any transition or new evidence.
  const facts={contract:CONTRACT_ID,intent,attempt,readbacks:rows.map(e=>({seq:e.seq,sha256:sha256(canonical(e))})),orders,voids,incident,resolution};
  return {incident,intent,attempt,evidence,orders,evaluation,resolution,factsJson:canonical(facts),providerHash:sha256(canonical({attempt,evidence}))};
 }
 private recordEvaluation(s:ReturnType<RepairService['snapshot']>,runId:string):number {
  return Number(this.store.db.prepare(`INSERT INTO invariant_evaluations(organization_id,contract,intent_id,result,active_order_count,reasons_json,facts_json,run_id,evaluated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
   .run(this.organizationId,CONTRACT_ID,s.intent.id,s.evaluation.result,s.evaluation.activeOrderCount,canonical(s.evaluation.reasons),canonical({matchingOrderIds:s.evaluation.matchingOrderIds,repairFacts:JSON.parse(s.factsJson)}),runId,this.at()).lastInsertRowid);
 }
 private eligible(s:ReturnType<RepairService['snapshot']>){
  const active=s.orders.filter(o=>o.effective_status==='placed');
  if(s.resolution)throw Error('incident already resolved');
  if(!s.evaluation.eligible||s.evaluation.result!=='VIOLATED'||active.length<2||s.evaluation.matchingOrderIds.length!==active.length)throw Error('REFUSED_MISMATCHED_ORDERS or uncertain/non-eligible payment');
  // Historical incident identity must also agree with current capture, not just current orders.
  if(s.incident.attempt_id!==s.attempt.id||s.incident.paypal_order_id!==s.attempt.paypal_order_id||s.incident.capture_id!==s.attempt.capture_id)throw Error('incident payment identity mismatch');
  return active;
 }
 plan(incidentId:string,requester:string):RepairPlan {
  return this.store.tx(()=>{
   const s=this.snapshot(incidentId),active=this.eligible(s);
   const pending=this.store.db.prepare(`SELECT 1 FROM repair_plans p JOIN repair_approvals a ON a.plan_id=p.id WHERE p.incident_id=? AND p.expires_at>?
    AND NOT EXISTS(SELECT 1 FROM repair_executions e JOIN repair_outcomes o ON o.execution_id=e.id WHERE e.plan_id=p.id)`).get(incidentId,this.at());
   if(pending)throw Error('an approved unconsumed plan already exists');
   const created=this.now();
   const p:RepairPlan={id:`rp_${randomUUID()}`,organization_id:this.organizationId,incident_id:incidentId,intent_id:s.intent.id,contract:CONTRACT_ID,
    evaluation_seq:this.recordEvaluation(s,`plan_${randomUUID()}`),keep_order_id:active[0]!.id,void_order_ids_json:canonical(active.slice(1).map(o=>o.id).sort()),
    cause_at_plan:canonical(JSON.parse(s.incident.reproduction_json)),facts_json:s.factsJson,facts_sha256:sha256(s.factsJson),plan_sha256:'',requester_name:name(requester),
    created_at:new Date(created).toISOString(),expires_at:new Date(created+15*60*1000).toISOString()};
   p.plan_sha256=hashPlan(p);
   const keys=Object.keys(p) as Array<keyof RepairPlan>;
   this.store.db.prepare(`INSERT INTO repair_plans(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>p[k]));
   this.audit(p.id,'PLANNED',{requester:p.requester_name,identityAssurance:'LOCAL_DEMO_DECLARED_OPERATOR'});return p;
  });
 }
 private approve(id:string,hash:string,operator:string,confirmation:string,mode:'INTERACTIVE_TTY'|'SIMULATED_TEST') {
  return this.store.tx(()=>{
   const p=this.getPlan(id);
   if(hash!==p.plan_sha256||hashPlan(p)!==hash||confirmation!==hash.slice(-8))throw Error('exact plan hash and typed confirmation required');
   if(this.now()<Date.parse(p.created_at)||this.now()>=Date.parse(p.expires_at))throw Error('plan expired or clock invalid');
   if(sha256(this.snapshot(p.incident_id).factsJson)!==p.facts_sha256)throw Error('stale plan');
   const op=name(operator);
   this.store.db.prepare(`INSERT INTO repair_approvals(id,plan_id,plan_sha256,operator_name,identity_assurance,approval_mode,approved_at) VALUES(?,?,?,?, 'LOCAL_DEMO_DECLARED_OPERATOR',?,?)`)
    .run(`ra_${randomUUID()}`,p.id,hash,op,mode,this.at());
   this.audit(p.id,'APPROVED',{operator:op,identityAssurance:'LOCAL_DEMO_DECLARED_OPERATOR',mode});
  });
 }
 /** Test fixtures only: intentionally conspicuous persisted assurance/mode. CLI has no simulation switch. */
 approveSimulated(id:string,hash:string,operator:string,confirmation:string){
  if(process.env.NODE_ENV!=='test')throw Error('simulated approval is test-only');
  this.approve(id,hash,operator,confirmation,'SIMULATED_TEST');
 }
 async approveInteractive(id:string,hash:string,operator:string) {
  if(!stdin.isTTY||!stdout.isTTY)throw Error('approval requires interactive input and output TTY');
  const p=this.getPlan(id);
  if(p.plan_sha256!==hash||hashPlan(p)!==hash)throw Error('plan hash mismatch');
  stdout.write(`${canonical(p)}\nLOCAL_DEMO_DECLARED_OPERATOR: unauthenticated declared identity. No enforced separation of duties.\nNo PayPal action. Original order records remain immutable.\n`);
  const rl=createInterface({input:stdin,output:stdout});
  try {const typed=await rl.question(`Type ${hash.slice(-8)} to approve this exact plan: `);this.approve(id,hash,operator,typed,'INTERACTIVE_TTY');} finally {rl.close();}
 }
 execute(planId:string):Outcome {
  const result=this.store.tx(()=>{
   const p=this.getPlan(planId);
   const previous=this.store.db.prepare('SELECT o.* FROM repair_outcomes o JOIN repair_executions e ON e.id=o.execution_id WHERE e.plan_id=?').get(p.id) as Outcome|undefined;
   if(previous)return previous;
   const execution=`rx_${randomUUID()}`;
   this.store.db.prepare('INSERT INTO repair_executions VALUES(?,?,?)').run(execution,p.id,this.at());
   this.store.db.prepare("INSERT INTO repair_transitions VALUES(?,'EXECUTING',?)").run(execution,this.at());
   this.options.boundary?.('after_begin');
   // An edited plan's scope is untrusted. Refuse before dereferencing any of its references.
   if(hashPlan(p)!==p.plan_sha256||sha256(p.facts_json)!==p.facts_sha256){
    const providerHash=sha256(canonical({
     attempts:this.store.db.prepare('SELECT a.* FROM payment_attempts a JOIN checkout_intents i ON i.id=a.intent_id WHERE i.organization_id=? ORDER BY a.id').all(this.organizationId),
     evidence:this.store.db.prepare('SELECT e.* FROM evidence e JOIN payment_attempts a ON a.id=e.attempt_id JOIN checkout_intents i ON i.id=a.intent_id WHERE i.organization_id=? ORDER BY e.seq').all(this.organizationId)
    }));
    const refusal:Outcome={execution_id:execution,outcome:'REJECTED_INTEGRITY',reasons_json:canonical(['plan integrity failed; provider hashes cover organization scope because plan references are untrusted']),provider_before_sha256:providerHash,provider_after_sha256:providerHash,completed_at:this.at()};
    this.store.db.prepare('INSERT INTO repair_outcomes VALUES(?,?,?,?,?,?)').run(...Object.values(refusal));
    this.audit(p.id,refusal.outcome,{executionId:execution});this.options.boundary?.('before_commit');return refusal;
   }
   const before=this.snapshot(p.incident_id);
   let outcome:Outcome['outcome']='SUCCEEDED', reasons:string[]=[];
   const approval=this.store.db.prepare('SELECT * FROM repair_approvals WHERE plan_id=?').get(p.id) as {plan_sha256:string;identity_assurance:string;approved_at:string;approval_mode:string}|undefined;
   if(outcome==='SUCCEEDED'&&(!approval||approval.plan_sha256!==p.plan_sha256||approval.identity_assurance!=='LOCAL_DEMO_DECLARED_OPERATOR'||
    !['INTERACTIVE_TTY','SIMULATED_TEST'].includes(approval.approval_mode)||!Number.isFinite(Date.parse(approval.approved_at))||approval.approved_at<p.created_at||approval.approved_at>=p.expires_at||Date.parse(approval.approved_at)>this.now()))outcome='REJECTED_APPROVAL';
   if(outcome==='SUCCEEDED'&&(!Number.isFinite(Date.parse(p.expires_at))||this.now()>=Date.parse(p.expires_at)||this.now()<Date.parse(p.created_at)))outcome='REJECTED_EXPIRED';
   if(outcome==='SUCCEEDED') {
    try {
     const active=this.eligible(before),expectedVoids=canonical(active.slice(1).map(o=>o.id).sort());
     if(sha256(before.factsJson)!==p.facts_sha256||before.factsJson!==p.facts_json||p.intent_id!==before.intent.id||p.contract!==CONTRACT_ID||
      p.keep_order_id!==active[0]!.id||p.void_order_ids_json!==expectedVoids)throw Error('current facts or keeper differ');
    }catch{outcome='REJECTED_STALE';}
   }
   if(outcome==='SUCCEEDED'){
    this.store.db.exec('SAVEPOINT correction');
    try {
     const voidIds=JSON.parse(p.void_order_ids_json) as string[];
     for(const id of voidIds)this.store.db.prepare("INSERT INTO merchant_order_voids VALUES(?,?,'DUPLICATE_MERCHANT_ORDER',?)").run(id,execution,this.at());
     this.options.boundary?.('after_voids');
     const post=this.snapshot(p.incident_id);
     if(post.evaluation.result!=='HOLDS'||post.evaluation.activeOrderCount!==1||canonical(post.evaluation.matchingOrderIds)!==canonical([p.keep_order_id])||post.providerHash!==before.providerHash)throw Error('postcondition failed');
     const evaluation=this.recordEvaluation(post,execution);
     this.options.boundary?.('after_postcondition');
     this.store.db.prepare('INSERT INTO incident_resolutions VALUES(?,?,?,?)').run(p.incident_id,evaluation,execution,this.at());
     this.store.db.exec('RELEASE correction');
    }catch{
     this.store.db.exec('ROLLBACK TO correction; RELEASE correction');
     this.options.boundary?.('after_rollback');
     outcome='FAILED_POSTCONDITION';reasons=['local correction failed independent postcondition or storage constraint; all corrections rolled back'];
    }
   }
   const after=this.snapshot(p.incident_id);
   const terminal:Outcome={execution_id:execution,outcome,reasons_json:canonical(reasons.length?reasons:outcome==='SUCCEEDED'?[]:[outcome]),provider_before_sha256:before.providerHash,provider_after_sha256:after.providerHash,completed_at:this.at()};
   this.store.db.prepare('INSERT INTO repair_outcomes VALUES(?,?,?,?,?,?)').run(...Object.values(terminal));
   this.audit(p.id,outcome,{executionId:execution});this.options.boundary?.('before_commit');return terminal;
  });
  this.options.boundary?.('after_commit');return result;
 }
 history(incidentId:string){
  if(!this.repo.getIncident(this.organizationId,incidentId))throw Error('incident not found for organization');
  const db=this.store.db;
  return {identityAssurance:'LOCAL_DEMO_DECLARED_OPERATOR',authentication:'NONE',separationOfDutiesEnforced:false,
   plans:db.prepare('SELECT * FROM repair_plans WHERE incident_id=? AND organization_id=? ORDER BY created_at,id').all(incidentId,this.organizationId),
   approvals:db.prepare('SELECT a.* FROM repair_approvals a JOIN repair_plans p ON p.id=a.plan_id WHERE p.incident_id=? AND p.organization_id=?').all(incidentId,this.organizationId),
   executions:db.prepare('SELECT e.*,o.* FROM repair_executions e JOIN repair_plans p ON p.id=e.plan_id LEFT JOIN repair_outcomes o ON o.execution_id=e.id WHERE p.incident_id=? AND p.organization_id=?').all(incidentId,this.organizationId),
   audit:db.prepare('SELECT a.* FROM repair_audit a JOIN repair_plans p ON p.id=a.plan_id WHERE p.incident_id=? AND p.organization_id=? ORDER BY a.seq').all(incidentId,this.organizationId)};
 }
}
