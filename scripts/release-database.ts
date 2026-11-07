import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {Resolver} from 'node:dns/promises';
import {Client} from 'pg';
import {requireV9Drain} from './release-policy.ts';
/** Private read-only gate. Credentials never become arguments, output or Git data. */
export async function inspectReleaseDatabase(envFile:string){
 const u=new URL(parseEnv(readFileSync(envFile,'utf8')).DATABASE_URL??'');
 const host='ep-broad-pond-b7ukxrlx.c-13.us-east-1.aws.neon.tech';
 if(![host,host.replace('b7ukxrlx.','b7ukxrlx-pooler.')].includes(u.hostname)||u.pathname!=='/neondb'||u.username!=='neondb_owner'||(u.port&&u.port!=='5432'))throw new Error('Release database target mismatch');
 const resolver=new Resolver({timeout:3000,tries:1});resolver.setServers(['1.1.1.1']);
 const address=(await resolver.resolve4(host))[0];if(!address)throw new Error('Direct database DNS unavailable');
 const c=new Client({host:address,port:5432,user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),database:'neondb',ssl:{rejectUnauthorized:true,servername:host},connectionTimeoutMillis:10000,application_name:'ordertruth-release-readonly',options:'-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=5000'});
 c.on('error',()=>{}); // Pending queries reject; keep asynchronous disconnects inside the release/HOLD error path.
 try{await c.connect();await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const versions=(await c.query('SELECT version FROM ordertruth.ordertruth_postgres_migrations ORDER BY version')).rows.map(r=>r.version as number);
  const counts=(await c.query(`SELECT
   (SELECT count(*)::int FROM ordertruth.payment_attempts WHERE state IN('capture_in_progress','pending','uncertain') OR (capture_claims>0 AND state<>'captured')) AS "pendingCaptures",
   ((SELECT count(*) FROM ordertruth.webhook_events WHERE state NOT IN('processed','foreign','ignored'))+(SELECT count(*) FROM ordertruth.webhook_deliveries WHERE state IN('received_unverified','retryable_failure')))::int AS "pendingWebhooks",
   (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND xact_start IS NOT NULL) AS "activeTransactions"`)).rows[0];
  const state={versions,pendingCaptures:Number(counts.pendingCaptures),pendingWebhooks:Number(counts.pendingWebhooks),activeTransactions:Number(counts.activeTransactions)};requireV9Drain(state);
  if(Number((await c.query('SELECT count(*)::int AS n FROM pg_prepared_xacts WHERE database=current_database()')).rows[0].n))throw new Error('Prepared transaction blocks release');
  if(Number((await c.query('SELECT count(*)::int AS n FROM ordertruth.repair_executions e LEFT JOIN ordertruth.repair_outcomes o ON o.execution_id=e.id WHERE o.execution_id IS NULL')).rows[0].n))throw new Error('Uncertain merchant execution blocks release');
  const fingerprints:Record<string,{rows:string;sha256:string}>={};
  for(const table of ['checkout_intents','payment_attempts','evidence','merchant_orders','merchant_order_voids','repair_plans','repair_approvals','repair_executions','repair_outcomes','repair_audit','scenario_runs','scenario_run_orders','scenario_run_plans','scenario_run_incidents','incidents','invariant_evaluations','incident_resolutions','scenario_operations','scenario_admissions'])fingerprints[table]=(await c.query(`SELECT count(*)::text AS rows,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text COLLATE "C"),''),'UTF8')),'hex') AS sha256 FROM ordertruth.${table} t`)).rows[0];
  await c.query('ROLLBACK');return {...state,fingerprints};
 }finally{await c.end().catch(()=>{});}
}
