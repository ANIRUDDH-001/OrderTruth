export function requireGreenChecks(checks:Array<{id:number;name:string;status:string;conclusion:string|null;started_at:string|null}>){
 for(const name of ['offline','postgres','v3-postgres']){
  const latest=checks.filter(c=>c.name===name).sort((a,b)=>b.id-a.id)[0];
  if(!latest||latest.status!=='completed')throw new Error(`Pending CI gate: ${name}`);
  if(latest.conclusion!=='success')throw new Error(`Failed CI gate: ${name}`);
 }
}
/** Qualification opens only one durable daily reservation. HOLD/rollback
 * always disables inference, independently of private environment values. */
export function releaseStartCommand(mode:'hold'|'normal',qualifyGroq:boolean|'approved-rollout'=false){
 const limits=qualifyGroq==='approved-rollout'?'AI_DAILY_LIMIT=12 AI_USER_DAILY_LIMIT=3':'AI_DAILY_LIMIT=1 AI_USER_DAILY_LIMIT=1';
 const ai=mode==='normal'&&qualifyGroq?`AI_PROVIDER=groq AI_MODEL=openai/gpt-oss-120b ${limits}`:'AI_PROVIDER=disabled AI_DAILY_LIMIT=0 AI_USER_DAILY_LIMIT=0';
 return `env -u ORDERTRUTH_MIGRATION -u ORDERTRUTH_BARRIER_FILE ORDERTRUTH_RELEASE_MODE=${mode} ${ai} pnpm hosted:start`;
}
export function requireV9Drain(state:{versions:number[];pendingCaptures:number;pendingWebhooks:number;activeTransactions:number}){
 if(JSON.stringify(state.versions)!==JSON.stringify([1,2,3,4,5,6,7,8,9])||state.pendingCaptures||state.pendingWebhooks||state.activeTransactions)throw new Error('V9 schema or financial writer-drain gate failed');
}
/** Reviewed Phase 6 code-only change, not a general database-path exemption.
 * These Git blob identities bind both sides of the inspected transition. */
export function requireReviewedDatabaseChanges(changes:Array<{path:string;before:string;after:string}>){
 for(const change of changes){
  if(change.path!=='src/db/postgres-checkout.ts'||change.before!=='c34fed719ab0ae564d86f583d68f3857405e9ec1'||change.after!=='09aafdb195771fd681f3470f8dd702a62158fb4c'){
   throw new Error('Database-code changes require a separately reviewed recovery/migration procedure');
  }
 }
}
/** Observe the existing owner-managed plan; never provisions or upgrades it. */
export function requireReleaseServiceConfiguration(config:{id?:string;ownerId?:string;autoDeploy?:string;serviceDetails?:{plan?:string;numInstances?:number;envSpecificDetails?:{startCommand?:string}}}|undefined){
 if(config?.id!=='srv-dbccdgjl550s73d37ao0'||config.ownerId!=='tea-d6qpqrpaae7s739l8qu0'
  ||!['free','0.5c-512mb'].includes(config.serviceDetails?.plan??'')||config.serviceDetails?.numInstances!==1||config.autoDeploy!=='no'
  ||/ORDERTRUTH_MIGRATION\s*=|apply-v9/.test(config.serviceDetails?.envSpecificDetails?.startCommand??''))throw new Error('Unsafe service configuration');
}
