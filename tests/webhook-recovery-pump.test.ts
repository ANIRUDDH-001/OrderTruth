import {expect,it,vi} from 'vitest';
import {webhookRecoveryPump} from '../src/webhooks/recovery-pump.ts';

it('reschedules a durable retry at its due time, then stops polling when idle',async()=>{
 vi.useFakeTimers();
 let due:number|null=Date.now(),attempts=0,active=0;
 const nextDueAt=vi.fn(async()=>due);
 const pump=webhookRecoveryPump({nextDueAt,enter:()=>{active++;return()=>{active--;};},report:()=>{},drain:async max=>{
   expect(max).toBe(1);attempts++;due=attempts===1?Date.now()+5000:null;return 1;
 }});
 try{
   pump.start();await vi.advanceTimersByTimeAsync(25);expect(attempts).toBe(1);expect(active).toBe(0);
   await vi.advanceTimersByTimeAsync(4999);expect(attempts).toBe(1);
   await vi.advanceTimersByTimeAsync(1);expect(attempts).toBe(2);
   const reads=nextDueAt.mock.calls.length;await vi.advanceTimersByTimeAsync(60_000);expect(nextDueAt).toHaveBeenCalledTimes(reads);
 }finally{await pump.stop();vi.useRealTimers();}
});
