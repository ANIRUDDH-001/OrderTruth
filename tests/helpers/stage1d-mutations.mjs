import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const file='src/merchant/repair.ts', original=readFileSync(file,'utf8');
const cases=[
 ['R01-plan-integrity',"if(hashPlan(p)!==p.plan_sha256||sha256(p.facts_json)!==p.facts_sha256){","if(false){",'wrong hash|review regression|edited plan facts'],
 ['R02-approval',"if(outcome==='SUCCEEDED'&&(!approval", "if(false&&(!approval",'missing approval|corrupted stored approval'],
 ['R03-expiry',"if(outcome==='SUCCEEDED'&&(!Number.isFinite(Date.parse(p.expires_at))", "if(false&&(!Number.isFinite(Date.parse(p.expires_at))",'exact expiry'],
 ['R04-stale-facts',"sha256(before.factsJson)!==p.facts_sha256||before.factsJson!==p.facts_json",'false','additional correct order|additional readback'],
 ['R05-keeper',"p.keep_order_id!==active[0]!.id",'false','wrong keeper'],
 ['R06-void-set',"p.void_order_ids_json!==expectedVoids",'false','wrong keeper'],
 ['R07-eligibility',"if(!s.evaluation.eligible||s.evaluation.result!=='VIOLATED'||active.length<2||s.evaluation.matchingOrderIds.length!==active.length)","if(false)",'legacy mismatched|every active order'],
 ['R08-postcondition',"post.evaluation.result!=='HOLDS'||post.evaluation.activeOrderCount!==1||canonical(post.evaluation.matchingOrderIds)!==canonical([p.keep_order_id])",'false','actual failed HOLDS|matching order count'],
 ['R09-provider-preservation',"post.providerHash!==before.providerHash",'false','provider tampering|provider preservation'],
 ['R10-resolution-stale',"if(s.resolution)throw Error('incident already resolved');",'','two preexisting approved|plan →'],
 ['R11-idempotency',"if(previous)return previous;",'','RP1 RP11|RP10 close'],
 ['R12-savepoint-rollback',"this.store.db.exec('ROLLBACK TO correction; RELEASE correction');","this.store.db.exec('RELEASE correction');",'postcondition failure|actual failed HOLDS'],
 ['R13-approval-hash',"approval.plan_sha256!==p.plan_sha256",'false','corrupted stored approval'],
 ['R14-approval-assurance',"approval.identity_assurance!=='LOCAL_DEMO_DECLARED_OPERATOR'",'false','corrupted stored approval'],
];
mkdirSync('.work/runs/stage1d/mutations',{recursive:true});const results=[];
try {for(const [id,from,to,filter]of cases){if(original.split(from).length!==2)throw Error('mutation anchor not unique: '+id);writeFileSync(file,original.replace(from,to));const r=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','tests/stage1d-repair.test.ts','-t',filter],{encoding:'utf8',timeout:20000,maxBuffer:2e6});writeFileSync(`.work/runs/stage1d/mutations/${id}.txt`,r.stdout+'\n'+r.stderr);const status=r.error?'HARNESS_ERROR':r.status===0?'SURVIVED':'KILLED';results.push({id,status,exit:r.status});console.log(id+' '+status);writeFileSync(file,original);}}
finally{writeFileSync(file,original);writeFileSync('.work/runs/stage1d/mutations/results.json',JSON.stringify({results,restoredSha256:createHash('sha256').update(readFileSync(file)).digest('hex')},null,2));}

