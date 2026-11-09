import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {withTransaction} from "../db/postgres.ts";

export const GUEST_ADMISSION_PER_MINUTE=30;
const NETWORK_LIMIT=12;
const WINDOW_MS=60_000;
const GLOBAL_KEY="ordertruth:guest-admission:v1";
const GROUP_PREFIX="ordertruth:guest-network:";
const networkDenied=Symbol("guest network allowance reached");

async function reserve(database:Pick<Pool,"query">,key:string,limit:number):Promise<number>{
  const result=await database.query(`WITH clock AS (
    SELECT floor(extract(epoch FROM statement_timestamp())*1000)::bigint AS now_ms
  ) INSERT INTO ot_auth_rate_limit(id,"key","count","lastRequest")
    SELECT $1,$2,1,now_ms FROM clock
    ON CONFLICT ("key") DO UPDATE SET
      "count"=CASE WHEN ot_auth_rate_limit."lastRequest"<=(SELECT now_ms FROM clock)-$3 THEN 1 ELSE ot_auth_rate_limit."count"+1 END,
      "lastRequest"=CASE WHEN ot_auth_rate_limit."lastRequest"<=(SELECT now_ms FROM clock)-$3 THEN (SELECT now_ms FROM clock) ELSE ot_auth_rate_limit."lastRequest" END
    WHERE ot_auth_rate_limit."lastRequest"<=(SELECT now_ms FROM clock)-$3 OR ot_auth_rate_limit."count"<$4
    RETURNING "count"`,[`rate_${randomUUID()}`,key,WINDOW_MS,limit]);
  return result.rows[0]?.count ?? 0;
}

/** Shared caps reserve only new identities. Failed/uncertain creation keeps
 * its reservation, while an admission refusal leaves both counters intact. */
export async function reserveGuestAdmission(pool:Pool,group?:string):Promise<boolean>{
  if (group === undefined) return (await reserve(pool,GLOBAL_KEY,GUEST_ADMISSION_PER_MINUTE)) > 0;
  try {
    return await withTransaction(pool,async client => {
      const total = await reserve(client,GLOBAL_KEY,GUEST_ADMISSION_PER_MINUTE);
      if (!total) return false;
      if (!await reserve(client,GROUP_PREFIX+group,NETWORK_LIMIT)) throw networkDenied;
      if (total === 1) await client.query(`DELETE FROM ot_auth_rate_limit WHERE "key" LIKE $1
        AND "lastRequest" < extract(epoch FROM statement_timestamp())*1000-$2`,[GROUP_PREFIX+"%",2*WINDOW_MS]);
      return true;
    });
  } catch (error) {
    if (error === networkDenied) return false;
    throw error;
  }
}
