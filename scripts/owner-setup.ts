import { randomBytes } from "node:crypto";
import { readFileSync,existsSync,mkdirSync,writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { betterAuth } from "better-auth";
import { appEnvironment } from "../src/server/hosted-environment.ts";
import { loadPostgresConfig } from "../src/config.ts";
import { createPostgresPool } from "../src/db/postgres.ts";
import { migratePostgres } from "../src/db/postgres-migrate.ts";
import { createSessionAuth } from "../src/server/auth.ts";

// Private CLI only; never mounted as a public registration endpoint. The
// maintained library hashes the password and creates the credential account.
const { env,privatePath } = appEnvironment(process.argv.includes("--local"));
env.AUTH_SECRET ||= randomBytes(48).toString("base64url");
env.APP_ORIGIN ||= "http://127.0.0.1:3003";
const config = loadPostgresConfig(env);
const pool = createPostgresPool(config.databaseUrl);
pool.options.options += " -c search_path=ordertruth,pg_catalog";
try {
  await migratePostgres(pool,"ordertruth");
  if (env.OWNER_USER_ID) {
    const owner = (await pool.query('SELECT id FROM ordertruth.ot_auth_user WHERE id=$1 AND "isAnonymous" IS NOT TRUE', [env.OWNER_USER_ID])).rows[0];
    if (!owner) throw new Error("Configured owner is not present in this database");
    console.log("Owner already configured; credentials were not changed.");
  } else {
    const email = env.OWNER_LOGIN_EMAIL || "owner@ordertruth.invalid";
    const password = env.OWNER_LOGIN_PASSWORD || randomBytes(32).toString("base64url");
    const base = createSessionAuth(pool,config.origin,config.authSecret);
    // Registration is enabled only on this unserved bootstrap instance.
    const bootstrap = betterAuth({ ...base.options,emailAndPassword: { ...base.options.emailAndPassword,enabled: true,disableSignUp: false } });
    const existing = (await pool.query('SELECT id FROM ordertruth.ot_auth_user WHERE email=$1', [email])).rows[0];
    const result = existing ? await bootstrap.api.signInEmail({ body: { email,password } }) : await bootstrap.api.signUpEmail({ body: { email,password,name: "OrderTruth owner" } });
    const values: Record<string,string> = { AUTH_SECRET: config.authSecret,APP_ORIGIN: config.origin,OWNER_USER_ID: result.user.id,OWNER_LOGIN_EMAIL: email,OWNER_LOGIN_PASSWORD: password };
    let content = existsSync(privatePath) ? readFileSync(privatePath,"utf8") : "";
    for (const [key,value] of Object.entries(values)) {
      const pattern = new RegExp(`^${key}=.*$`,"m");
      content = pattern.test(content) ? content.replace(pattern,`${key}=${value}`) : `${content.trimEnd()}\n${key}=${value}\n`;
    }
    mkdirSync(dirname(privatePath),{ recursive: true }); writeFileSync(privatePath,content,{ mode: 0o600 });
    console.log(`Owner created. Private sign-in credentials are in ${privatePath}; no values are printed.`);
  }
} catch { console.error("Owner setup failed; private configuration and database identity need inspection. No credentials printed.");process.exitCode = 1; }
finally { await pool.end(); }
