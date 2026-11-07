export function requireGreenChecks(checks:Array<{id:number;name:string;status:string;conclusion:string|null;started_at:string|null}>){
 for(const name of ['offline','postgres','v3-postgres']){
  const latest=checks.filter(c=>c.name===name).sort((a,b)=>b.id-a.id)[0];
  if(!latest||latest.status!=='completed')throw new Error(`Pending CI gate: ${name}`);
  if(latest.conclusion!=='success')throw new Error(`Failed CI gate: ${name}`);
 }
}
export function requireV9Drain(state:{versions:number[];pendingCaptures:number;pendingWebhooks:number;activeTransactions:number}){
 if(JSON.stringify(state.versions)!==JSON.stringify([1,2,3,4,5,6,7,8,9])||state.pendingCaptures||state.pendingWebhooks||state.activeTransactions)throw new Error('V9 schema or financial writer-drain gate failed');
}
