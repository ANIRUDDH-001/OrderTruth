import {afterEach,expect,it,vi} from 'vitest';
import {mountJudge,scenario} from './helpers/judge-dom.ts';
afterEach(async()=>{if(vi.isFakeTimers())await vi.runAllTimersAsync();vi.useRealTimers();vi.unstubAllGlobals();vi.resetModules();});
const session={authenticated:true,userId:'synthetic-user',owner:false};
const evidence={id:'synthetic-merchant-id',source:'CONTROLLED_MERCHANT_STATE',observedAt:'2026-11-08T00:00:00.000Z',facts:{}};
const diagnostic={id:'synthetic-diagnostic-id',source:'MERCHANT_DIAGNOSTIC',observedAt:evidence.observedAt,facts:{diagnostic:'IDEMPOTENCY_KEYS',entries:[],distinctKeys:0}};
const baseline={summary:'Synthetic rules guidance',nextDiagnostic:'IDEMPOTENCY_KEYS'};
const saved={status:'CACHED',freshModelExecution:false,evidence:[evidence],baseline,investigation:{summary:'Synthetic fixture advice',nextDiagnostic:'IDEMPOTENCY_KEYS',diagnosticReason:'Compare recorded keys',hypotheses:[{explanation:'Synthetic hypothesis',confidence:'LOW',status:'HYPOTHESIS',evidenceIds:[evidence.id]}]}};
function owned(){const s=scenario('run_owned');s.orders.push({...s.orders[0]!,id:'synthetic-duplicate'});return {...s,latestCheck:{seq:1,result:'VIOLATED',activeOrderCount:2,evaluatedAt:evidence.observedAt,incidentId:'synthetic-incident'}};}
it('names cited evidence and requires an explicit reassessment after a new diagnostic',async()=>{
 const ui=await mountJudge(c=>c.path==='/api/session'?session:c.path.endsWith('/investigation')?saved:c.path.endsWith('/diagnostics')?diagnostic:c.path.endsWith('/investigate')?{...saved,status:'FRESH',freshModelExecution:true,generatedAt:evidence.observedAt,evidence:[evidence,diagnostic]}:owned(),'run_owned');
 expect(ui.doc.root.querySelectorAll('p').find(p=>p.textContent.startsWith('Evidence:'))?.textContent).toBe('Evidence: Merchant order records');
 await ui.click('Run idempotency-key comparison');
 expect(ui.doc.root.textContent).toContain('The saved AI advice predates it');
 expect(ui.calls.filter(c=>c.path.endsWith('/investigate'))).toHaveLength(0);
 await ui.click('Reassess with new evidence');
 expect(ui.calls.filter(c=>c.path.endsWith('/investigate'))).toHaveLength(1);
 expect(ui.doc.root.textContent).not.toContain('The saved AI advice predates it');
});
it('does not call rules-only guidance saved AI advice after diagnostics',async()=>{
 const unavailable={status:'UNAVAILABLE',freshModelExecution:false,reason:'BUDGET_DISABLED',evidence:[evidence],baseline};
 const ui=await mountJudge(c=>c.path==='/api/session'?session:c.path.endsWith('/investigation')?unavailable:c.path.endsWith('/diagnostics')?diagnostic:owned(),'run_owned');
 await ui.click('Run idempotency-key comparison');
 expect(ui.doc.root.textContent).not.toContain('The saved AI advice predates it');
 expect(ui.button('Investigate with AI').disabled).toBe(false);
 expect(ui.calls.filter(c=>c.path.endsWith('/investigate'))).toHaveLength(0);
});
it('restores newer diagnostics on reload without replacing the historical AI snapshot or running AI',async()=>{
 const ui=await mountJudge(c=>c.path==='/api/session'?session:c.path.endsWith('/investigation')?saved:{...owned(),diagnostics:[diagnostic]},'run_owned');
 expect(ui.doc.root.textContent).toContain('The saved AI advice predates it');
 expect(ui.doc.root.textContent).toContain('0 distinct merchant write keys observed');
 expect(ui.doc.root.textContent).toContain('Cached AI result');
 expect(ui.calls.every(c=>c.method==='GET')).toBe(true);
});
it('preserves the essential case when optional current diagnostics are malformed',async()=>{
 const ui=await mountJudge(c=>c.path==='/api/session'?session:c.path.endsWith('/investigation')?null:{...owned(),diagnostics:[{invalid:true}]},'run_owned');
 expect(ui.doc.root.textContent).toContain('duplicate active merchant orders');expect(ui.button('Review exact repair plan').disabled).toBe(false);expect(ui.calls.every(c=>c.method==='GET')).toBe(true);
});
it('does not offer an already recorded diagnostic and retains saved hypotheses after allowance refusal',async()=>{
 const unavailable={status:'UNAVAILABLE',freshModelExecution:false,reason:'SESSION_DAILY_BUDGET',evidence:[evidence,diagnostic],baseline};
 const ui=await mountJudge(c=>c.path==='/api/session'?session:c.path.endsWith('/investigation')?saved:c.path.endsWith('/investigate')?unavailable:{...owned(),diagnostics:[diagnostic]},'run_owned');
 expect(ui.doc.root.querySelectorAll('button').some(b=>b.textContent==='Run idempotency-key comparison')).toBe(false);
 await ui.click('Reassess with new evidence');expect(ui.doc.root.textContent).toContain('This session has used its daily AI allowance');
 expect(ui.doc.root.textContent).toContain('Synthetic hypothesis');expect(ui.doc.root.textContent).toContain('Cached AI result');
});
