import {randomUUID} from "node:crypto";
import type {Pool} from "pg";

export const GUEST_ADMISSION_PER_MINUTE=30;
const WINDOW_MS=60_000;
/** Reserve NEW anonymous identities across all peers/processes. Uses the existing
 * auth-rate table and the database clock; no client identity or proxy header
 * controls this key. Failed/uncertain attempts retain their reservation. */
export async function reserveGuestAdmission(pool:Pool):Promise<boolean>{
  const result=await pool.query(`WITH clock AS (
    SELECT floor(extract(epoch FROM statement_timestamp())*1000)::bigint AS now_ms
  ) INSERT INTO ot_auth_rate_limit(id,"key","count","lastRequest")
    SELECT $1,$2,1,now_ms FROM clock
    ON CONFLICT ("key") DO UPDATE SET
      "count"=CASE WHEN ot_auth_rate_limit."lastRequest"<=(SELECT now_ms FROM clock)-$3 THEN 1 ELSE ot_auth_rate_limit."count"+1 END,
      "lastRequest"=CASE WHEN ot_auth_rate_limit."lastRequest"<=(SELECT now_ms FROM clock)-$3 THEN (SELECT now_ms FROM clock) ELSE ot_auth_rate_limit."lastRequest" END
    WHERE ot_auth_rate_limit."lastRequest"<=(SELECT now_ms FROM clock)-$3 OR ot_auth_rate_limit."count"<$4
    RETURNING "count"`,[`rate_${randomUUID()}`,"ordertruth:guest-admission:v1",WINDOW_MS,GUEST_ADMISSION_PER_MINUTE]);
  return result.rowCount===1;
}
