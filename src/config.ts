import { z } from "zod";

/** The only PayPal REST host OrderTruth may call. Anything else fails closed. */
export const SANDBOX_API_BASE = "https://api-m.sandbox.paypal.com";
/** The only PayPal JS SDK v6 script origin OrderTruth may load. */
export const SANDBOX_SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";

export class ConfigError extends Error {
  /** Names of offending keys only; never values. */
  readonly keys: string[];
  constructor(message: string, keys: string[]) {
    super(message);
    this.name = "ConfigError";
    this.keys = keys;
  }
}

const nonEmpty = z.string().trim().min(1);
const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

const EnvSchema = z.object({
  PAYPAL_ENV: z.literal("sandbox"),
  PAYPAL_API_BASE: z.literal(SANDBOX_API_BASE),
  PAYPAL_CLIENT_ID: nonEmpty,
  PAYPAL_CLIENT_SECRET: nonEmpty,
  PAYPAL_WEBHOOK_ID: optionalString,
  AI_PROVIDER: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .transform((v) => (v ? v : "disabled"))
    .pipe(z.enum(["disabled", "gemini"])),
  AI_MODEL: optionalString,
  AI_API_KEY: optionalString,
  AI_BASE_URL: optionalString,
  DATABASE_URL: z.string().trim().default("file:./.work/ordertruth.sqlite"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PAYPAL_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
});

export type AppConfig = {
  paypal: {
    env: "sandbox";
    apiBase: typeof SANDBOX_API_BASE;
    clientId: string;
    clientSecret: string;
    webhookId: string | undefined;
    timeoutMs: number;
  };
  ai: {
    provider: "disabled" | "gemini";
    model: string | undefined;
    apiKey: string | undefined;
    baseUrl: string | undefined;
  };
  databasePath: string;
  port: number;
  logLevel: string;
  /** Every secret value, used by the redactor. */
  secrets: string[];
};

/** Hosts that must never be configured, even by accident. */
const PRODUCTION_HOST_PATTERN = /(^|\.)(api-m\.paypal\.com|api\.paypal\.com|www\.paypal\.com)$/i;

/**
 * Validate configuration from an env-like object. Fails closed on production hosts,
 * non-sandbox environments, and missing credentials. Error messages contain key names only.
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const base = env.PAYPAL_API_BASE?.trim();
  if (base) {
    let host = "";
    try {
      host = new URL(base).hostname;
    } catch {
      throw new ConfigError("PAYPAL_API_BASE is not a valid URL", ["PAYPAL_API_BASE"]);
    }
    if (PRODUCTION_HOST_PATTERN.test(host)) {
      throw new ConfigError("Production PayPal host is forbidden; only the Sandbox host is allowed", ["PAYPAL_API_BASE"]);
    }
  }
  if (env.PAYPAL_ENV && env.PAYPAL_ENV.trim().toLowerCase() !== "sandbox") {
    throw new ConfigError("PAYPAL_ENV must be 'sandbox'", ["PAYPAL_ENV"]);
  }

  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "?")))];
    throw new ConfigError(`Invalid or missing configuration: ${keys.join(", ")}`, keys);
  }
  const e = parsed.data;
  if (e.AI_PROVIDER === "gemini" && !e.AI_API_KEY) {
    throw new ConfigError("AI_PROVIDER=gemini requires AI_API_KEY", ["AI_API_KEY"]);
  }

  const dbUrl = e.DATABASE_URL;
  const databasePath = dbUrl.startsWith("file:") ? dbUrl.slice("file:".length) : dbUrl;

  return {
    paypal: {
      env: "sandbox",
      apiBase: SANDBOX_API_BASE,
      clientId: e.PAYPAL_CLIENT_ID,
      clientSecret: e.PAYPAL_CLIENT_SECRET,
      webhookId: e.PAYPAL_WEBHOOK_ID,
      timeoutMs: e.PAYPAL_HTTP_TIMEOUT_MS,
    },
    ai: { provider: e.AI_PROVIDER, model: e.AI_MODEL, apiKey: e.AI_API_KEY, baseUrl: e.AI_BASE_URL },
    databasePath,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    secrets: [e.PAYPAL_CLIENT_SECRET, e.AI_API_KEY, e.PAYPAL_WEBHOOK_ID].filter((s): s is string => !!s),
  };
}

/** Load `.env` into process.env (Node built-in, no values printed) and validate. */
export function loadConfigFromDotEnv(path = ".env"): AppConfig {
  try {
    process.loadEnvFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return loadConfig(process.env);
}
