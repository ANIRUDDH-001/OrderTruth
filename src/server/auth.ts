import { betterAuth } from "better-auth";
import { anonymous } from "better-auth/plugins";
import type { Pool } from "pg";

/** Same-origin maintained sessions. The pool must use the application's owned
 * search_path. Anonymous identities never grant payment/owner permissions. */
export function createSessionAuth(pool: Pool, origin: string, secret: string) {
  const url = new URL(origin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || !["http:","https:"].includes(url.protocol) || url.origin !== origin || secret.length < 32) throw new Error("Invalid authentication configuration");
  return betterAuth({
    appName: "OrderTruth", baseURL: origin, secret, database: pool,
    trustedOrigins: [origin],
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 14 },
    user: { modelName: "ot_auth_user" },
    session: { modelName: "ot_auth_session", expiresIn: 60*86400, updateAge: 86400, cookieCache: { enabled: false } },
    account: { modelName: "ot_auth_account" },
    verification: { modelName: "ot_auth_verification" },
    rateLimit: { enabled: true, storage: "database", modelName: "ot_auth_rate_limit", window: 60, max: 60,
      customRules: { "/sign-in/anonymous": { window: 60, max: 5 }, "/sign-in/email": { window: 60, max: 5 } } },
    advanced: { useSecureCookies: url.protocol === "https:", defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: url.protocol === "https:" },
      ipAddress: { ipAddressHeaders: ["x-ordertruth-client-ip"] } },
    plugins: [anonymous({ disableDeleteAnonymousUser: true })],
    telemetry: { enabled: false }, logger: { disabled: true },
  });
}
