import { readFileSync,existsSync } from "node:fs";
import { parseEnv } from "node:util";

/** Values never leave server-side configuration. Local mode uses the managed
 * loopback DB and its own private auth identity, preserving the root Neon DSN. */
export function appEnvironment(local: boolean) {
  const root = existsSync(".env") ? parseEnv(readFileSync(".env","utf8")) : {};
  const env: Record<string,string | undefined> = { ...root,...process.env };
  const privatePath = local ? ".work/local-app/.env" : ".env";
  if (local) {
    const database = parseEnv(readFileSync(".work/postgres/.env","utf8"));
    if (database.PGHOST !== "127.0.0.1" || database.PGPORT !== "55432" || database.PGDATABASE !== "ordertruth") throw new Error("Managed local database required");
    const privateConfig = existsSync(privatePath) ? parseEnv(readFileSync(privatePath,"utf8")) : {};
    for (const key of ["AUTH_SECRET","OWNER_USER_ID","OWNER_LOGIN_EMAIL","OWNER_LOGIN_PASSWORD","APP_SOURCE_ATTEMPT_ID"]) env[key] = privateConfig[key];
    env.DATABASE_URL = database.DATABASE_URL;
    env.APP_ORIGIN = privateConfig.APP_ORIGIN ?? "http://127.0.0.1:3003";
    env.PORT = new URL(env.APP_ORIGIN).port || "3003";
  }
  return { env,privatePath };
}
