/** Schedule only persisted verified work. An empty queue does not poll or keep
 * the database awake. PostgreSQL owns due times, leases and attempt limits. */
export function webhookRecoveryPump(deps:{nextDueAt():Promise<number|null>;drain(max:number):Promise<number>;enter():null|(()=>void);report(attempted:number|null):void}) {
  let running=false,again=false,timer:ReturnType<typeof setTimeout>|undefined,inFlight:Promise<void>|null=null;
  const schedule=(delay:number)=>{
    if(!running)return;
    clearTimeout(timer);timer=setTimeout(tick,Math.max(25,Math.min(600_000,delay)));timer.unref();
  };
  const wake=()=>{if(inFlight)again=true;else schedule(0);};
  function tick(){
    if(!running)return;
    const leave=deps.enter();
    if(!leave){schedule(30_000);return;} // HOLD performs no database or provider work.
    let due:number|null=null;
    inFlight=(async()=>{
      due=await deps.nextDueAt();
      if(due===null||due>Date.now())return;
      const attempted=await deps.drain(1);
      if(attempted)deps.report(attempted);
      due=await deps.nextDueAt();
    })().catch(()=>{due=Date.now()+30_000;deps.report(null);}).finally(()=>{
      leave();inFlight=null;
      if(again){again=false;wake();}
      else if(due!==null)schedule(due-Date.now());
    });
  }
  return {start(){if(!running){running=true;wake();}},wake,async stop(){running=false;again=false;clearTimeout(timer);await inFlight;}};
}
