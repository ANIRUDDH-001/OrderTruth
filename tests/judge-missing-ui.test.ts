import {afterEach,expect,it,vi} from 'vitest';
import {mountJudge,scenario} from './helpers/judge-dom.ts';
afterEach(async()=>{await vi.runAllTimersAsync();vi.useRealTimers();vi.unstubAllGlobals();vi.resetModules();});
it('restores an evidence-backed missing finding with diagnostics and no duplicate repair controls',async()=>{
 const s={...scenario('run_missing'),caseKind:'MISSING',orders:[],latestCheck:{seq:1,result:'VIOLATED',activeOrderCount:0,evaluatedAt:'2026-11-08T00:10:00Z',incidentId:'incident',incidentClass:'MISSING_MERCHANT_ORDER',missingOrder:{dueAt:'2026-11-08T00:05:00Z',confirmedAt:'2026-11-08T00:00:00Z'}}};
 const u=await mountJudge(c=>c.path==='/api/session'?{authenticated:true,userId:'fixture_user'}:c.path.endsWith('/investigation')?null:s,'run_missing');
 expect(u.doc.root.textContent).toContain('no reference merchant order after');expect(u.doc.root.textContent).toContain('investigation only');expect(u.doc.root.textContent).not.toContain('Review exact repair plan');expect(u.calls.every(c=>c.method==='GET')).toBe(true);
 expect(u.button('Run merchant write-outcome check').disabled).toBe(false);
});
it('persists the missing-case kind with its operation before sending creation',async()=>{
 const storage=new Map<string,string>();let posted:any;
 const u=await mountJudge((c,b)=>{if(c.path==='/api/session')return {authenticated:true,userId:'fixture_user'};if(c.path==='/api/scenarios'){posted=b;expect(JSON.parse(storage.get('ordertruth.judge.unidentifiedCreation')!).caseKind).toBe('MISSING');throw Error('Response lost');}return null;},'',storage);
 await u.click('Inspect a missing-order case');expect(posted.caseKind).toBe('MISSING');expect(u.doc.root.textContent).toContain('Recover the previous request first');
});
it('keeps detection current while the missing-order grace is still waiting',async()=>{
 const s={...scenario('run_waiting'),caseKind:'MISSING',orders:[],latestCheck:{seq:1,result:'OUT_OF_SCOPE',activeOrderCount:0,evaluatedAt:'2026-11-08T00:01:00Z',incidentId:null,missingOrder:{dueAt:'2026-11-08T00:05:00Z',confirmedAt:'2026-11-08T00:00:00Z'}}};
 const u=await mountJudge(c=>c.path==='/api/session'?{authenticated:true,userId:'fixture_user'}:c.path.endsWith('/investigation')?null:s,'run_waiting');
 expect(u.doc.root.textContent).toContain('DetectCurrent step');expect(u.button('Investigate with AI').disabled).toBe(true);
});
it('opens password confirmation for an existing owner only on the explicit recovery link',async()=>{
 const u=await mountJudge(()=>({authenticated:true,userId:'fixture_owner',owner:true}),'',new Map(),{url:'http://127.0.0.1:3333/?view=overview&reauth=1'});
 expect(u.doc.root.querySelector('#owner-password')).toBeTruthy();expect(u.doc.root.textContent).toContain('Confirm your password');expect(u.calls.every(c=>c.method==='GET')).toBe(true);
});
