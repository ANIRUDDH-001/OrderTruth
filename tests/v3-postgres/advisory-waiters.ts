/** Scope scheduling observations to this database and the bigint key namespace.
 * pg_locks itself is cluster-wide, including unrelated disposable test DBs. */
export async function countAdvisoryWaiters(client: { query(sql:string,values:unknown[]):Promise<{rows:Array<{n:string|number}>}> },key:number):Promise<number>{
  return Number((await client.query("SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=0 AND objid=$1 AND objsubid=1 AND NOT granted",[key])).rows[0]!.n);
}
