import {expect,it} from 'vitest';
import {waitForReleaseReadiness} from '../scripts/release-readiness.ts';
const sha='a'.repeat(40),identity={sourceSha:sha,schemaVersion:9,backendContract:'phase1-core-v1'},ready={ready:true,schemaVersion:9,backendContract:'phase1-core-v1'};
it('waits through old HOLD routing and requires both ingress paths to stabilize',async()=>{
 let time=0;const reads:string[]=[];
 await waitForReleaseReadiness(['https://direct.example','https://public.example'],sha,{now:()=>time,sleep:async ms=>{time+=ms;},timeoutMs:30000,read:async url=>{
  reads.push(url);if(time<5000||url.includes('public.example')&&time<10000)throw Error('Old HOLD instance HTTP503');
  return url.endsWith('/identity')?identity:ready;
 }});
 expect(time).toBe(15000);expect(reads.some(url=>url.includes('public.example'))).toBe(true);
});
it('never passes a stale source, wrong schema, false readiness or incompatible contract',async()=>{
 for(const invalid of [{...identity,sourceSha:'b'.repeat(40)},{...identity,schemaVersion:8},{...identity,backendContract:'other'}]){
  let time=0;await expect(waitForReleaseReadiness(['https://direct.example'],sha,{now:()=>time,sleep:async ms=>{time+=ms;},timeoutMs:10000,read:async url=>url.endsWith('/identity')?invalid:ready})).rejects.toThrow(/bounded deadline/);
 }
 let time=0;await expect(waitForReleaseReadiness(['https://direct.example'],sha,{now:()=>time,sleep:async ms=>{time+=ms;},timeoutMs:10000,read:async url=>url.endsWith('/identity')?identity:{...ready,ready:false}})).rejects.toThrow();
});
