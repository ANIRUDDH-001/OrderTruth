import {afterEach,expect,it,vi} from 'vitest';
import {mountJudge,scenario} from './helpers/judge-dom.ts';
const at='2026-11-10T01:00:00.000Z',evidence={id:'synthetic-merchant',source:'CONTROLLED_MERCHANT_STATE',observedAt:at,facts:{}};
const diagnostic={id:'synthetic-diagnostic',source:'MERCHANT_DIAGNOSTIC',observedAt:at,facts:{diagnostic:'IDEMPOTENCY_KEYS',entries:[],distinctKeys:2}};
const baseline={summary:'Rules found two merchant orders.',nextDiagnostic:'IDEMPOTENCY_KEYS'};
const investigation={summary:'Compare controlled merchant mechanisms.',nextDiagnostic:'IDEMPOTENCY_KEYS',diagnosticReason:'Inspect recorded keys.',hypotheses:[{explanation:'Different handler keys could permit duplicate writes.',confidence:'LOW',status:'HYPOTHESIS',evidenceIds:[evidence.id]}]};
const step={status:'FRESH',freshModelExecution:true,evidence:[evidence],baseline,investigation,snapshotSha256:'a'.repeat(64),model:'synthetic-model',generatedAt:at,usage:{promptTokens:400,outputTokens:20,totalTokens:420},concluded:false,executed:diagnostic};
const done={...step,snapshotSha256:'b'.repeat(64),evidence:[evidence,diagnostic],concluded:true,executed:null};
const empty={policy:'merchant-agent-v1',steps:[],concluded:false};
function owned(){const s=scenario('run_owned');s.orders.push({...s.orders[0]!,id:'synthetic-duplicate'});return {...s,diagnostics:[],latestCheck:{seq:1,result:'VIOLATED',activeOrderCount:2,evaluatedAt:at,incidentId:'synthetic-incident'}};}
const base=(p:string)=>p==='/api/session'?{authenticated:true,userId:'synthetic-user',owner:false}:p.endsWith('/investigation')?null:p.endsWith('/autopilot/trace')?empty:owned();
afterEach(async()=>{if(vi.isFakeTimers())await vi.runAllTimersAsync();vi.useRealTimers();vi.unstubAllGlobals();vi.resetModules();});
it('runs checks to conclusion, separates model choices from facts and focuses manual plan review',async()=>{
 let calls=0;const ui=await mountJudge(c=>c.method==='POST'&&c.path.endsWith('/autopilot')?++calls===1?step:done:base(c.path),'run_owned');
 await ui.click('Investigate with Autopilot');expect(calls).toBe(2);expect(ui.doc.root.textContent).toContain('Model chose');expect(ui.doc.root.textContent).toContain('Server verified');expect(ui.doc.root.textContent).toContain('2 distinct merchant write keys');expect(ui.doc.activeElement?.textContent).toBe('Review exact repair plan');
 expect(ui.calls.filter(c=>c.method==='POST').every(c=>c.path.endsWith('/autopilot'))).toBe(true);
});
it('waits for application spacing before continuing',async()=>{
 let calls=0;const ui=await mountJudge(c=>c.method==='POST'?++calls===1?{status:'UNAVAILABLE',reason:'APP_REQUEST_SPACING',retryAt:new Date(Date.now()+6000).toISOString(),baseline,evidence:[evidence],concluded:false,executed:null}:done:base(c.path),'run_owned');
 ui.button('Investigate with Autopilot').fire('click');await vi.advanceTimersByTimeAsync(0);expect(calls).toBe(1);await vi.advanceTimersByTimeAsync(6001);await ui.idle();expect(calls).toBe(2);expect(ui.doc.root.textContent).not.toContain("AI unavailable");expect(ui.doc.root.textContent).not.toContain("temporarily spaced out");
});
it('stops at allowance refusal and shows rules baseline',async()=>{
 const ui=await mountJudge(c=>c.method==='POST'?{status:'UNAVAILABLE',reason:'SESSION_DAILY_BUDGET',baseline,evidence:[evidence],concluded:false,executed:null}:base(c.path),'run_owned');
 await ui.click('Investigate with Autopilot');expect(ui.calls.filter(c=>c.method==='POST')).toHaveLength(1);expect(ui.doc.root.textContent).toContain('daily AI allowance');expect(ui.doc.root.textContent).toContain(baseline.summary);
});
it('reads trace after uncertain POST and never automatically reposts',async()=>{
 let reads=0;const ui=await mountJudge(c=>{if(c.method==='POST')throw Error('synthetic network interruption');if(c.path.endsWith('/autopilot/trace'))return ++reads===1?empty:{policy:'merchant-agent-v1',steps:[step],concluded:false};return base(c.path);},'run_owned');
 await ui.click('Investigate with Autopilot');expect(ui.calls.filter(c=>c.method==='POST')).toHaveLength(1);expect(reads).toBe(2);expect(ui.button('Continue Autopilot').disabled).toBe(false);expect(ui.doc.root.textContent).toContain('No request was replayed');
});
it('restores the trace without model requests on reload',async()=>{
 const ui=await mountJudge(c=>c.path.endsWith('/autopilot/trace')?{policy:'merchant-agent-v1',steps:[step,done],concluded:true}:base(c.path),'run_owned');
 expect(ui.doc.root.textContent).toContain('Model chose');expect(ui.doc.root.textContent).toContain('Investigation complete');expect(ui.calls.every(c=>c.method==='GET')).toBe(true);
});

it('keeps healthy and missing-case headlines factual',async()=>{
 for(const missing of [false,true]){
  const s=scenario('run_owned');if(missing)s.orders=[];
  const ui=await mountJudge(c=>c.path==='/api/session'?{authenticated:true,userId:'synthetic-user',owner:false}:c.path.endsWith('/investigation')?null:c.path.endsWith('/autopilot/trace')?empty:{...s,...(missing?{caseKind:'MISSING'}:{})},'run_owned');
  expect(ui.doc.root.querySelector('h1')?.textContent).not.toContain('Two merchant orders');
 }
});
