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
  // PayPal webhook ids are alphanumeric, <= 50 chars (verify-webhook-signature schema).
  PAYPAL_WEBHOOK_ID: optionalString.pipe(z.string().regex(/^[A-Za-z0-9]{1,50}$/).optional()),
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
  // Stage 1B: dedicated webhook listener (loopback only; the future tunnel target).
  WEBHOOK_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  WEBHOOK_VERIFY_TIMEOUT_MS: z.coerce.number().int().min(500).max(10000).default(5000),
  WEBHOOK_MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(262144).default(65536),
  WEBHOOK_MAX_TRANSMISSION_AGE_MS: z.coerce.number().int().min(60_000).max(4 * 24 * 3600_000).default(3600_000),
  // Pre-persistence ingress limits (unauthenticated traffic must not grow the inbox without bound).
  WEBHOOK_RATE_PER_MIN: z.coerce.number().int().min(1).max(6000).default(60),
  WEBHOOK_RATE_BURST: z.coerce.number().int().min(1).max(1000).default(30),
  WEBHOOK_MAX_STORED_UNVERIFIED: z.coerce.number().int().min(10).max(1_000_000).default(5000),
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
  webhook: {
    /** Always loopback. Exposure is only ever through an explicitly approved tunnel. */
    host: "127.0.0.1";
    port: number;
    verifyTimeoutMs: number;
    maxBodyBytes: number;
    maxTransmissionAgeMs: number;
    maxFutureSkewMs: number;
  };
  /** Pre-persistence bounds on the public webhook ingress. */
  webhookIngress: {
    ratePerMinute: number;
    rateBurst: number;
    maxStoredUnverified: number;
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
function validateEnvironment(env: Record<string, string | undefined>) {
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
  if (e.WEBHOOK_PORT === e.PORT) {
    throw new ConfigError("WEBHOOK_PORT must differ from PORT: the main app must never be the webhook/tunnel target", ["WEBHOOK_PORT"]);
  }
  if (e.PAYPAL_WEBHOOK_ID === "WEBHOOK_ID") {
    throw new ConfigError("PAYPAL_WEBHOOK_ID is the simulator placeholder, not a registered Sandbox webhook", ["PAYPAL_WEBHOOK_ID"]);
  }
  if (e.AI_PROVIDER === "gemini" && !e.AI_API_KEY) {
    throw new ConfigError("AI_PROVIDER=gemini requires AI_API_KEY", ["AI_API_KEY"]);
  }

  return e;
}

export function loadConfig(env: Record<string,string | undefined>): AppConfig {
  const e = validateEnvironment(env);
  const dbUrl = e.DATABASE_URL;
  if (/^postgres(?:ql)?:/i.test(dbUrl)) {
    throw new ConfigError("PostgreSQL application migration is not complete; this legacy command accepts a SQLite file path only", ["DATABASE_URL"]);
  }
  const databasePath = dbUrl.startsWith("file:") ? dbUrl.slice("file:".length) : dbUrl;
  return { ...sharedConfig(e),databasePath };
}
function sharedConfig(e: z.infer<typeof EnvSchema>): Omit<AppConfig,"databasePath"> {
  return {
    paypal: {
      env: "sandbox",
      apiBase: SANDBOX_API_BASE,
      clientId: e.PAYPAL_CLIENT_ID,
      clientSecret: e.PAYPAL_CLIENT_SECRET,
      webhookId: e.PAYPAL_WEBHOOK_ID,
      timeoutMs: e.PAYPAL_HTTP_TIMEOUT_MS,
    },
    webhook: {
      host: "127.0.0.1",
      port: e.WEBHOOK_PORT,
      verifyTimeoutMs: e.WEBHOOK_VERIFY_TIMEOUT_MS,
      maxBodyBytes: e.WEBHOOK_MAX_BODY_BYTES,
      maxTransmissionAgeMs: e.WEBHOOK_MAX_TRANSMISSION_AGE_MS,
      maxFutureSkewMs: 300_000,
    },
    webhookIngress: { ratePerMinute: e.WEBHOOK_RATE_PER_MIN, rateBurst: e.WEBHOOK_RATE_BURST, maxStoredUnverified: e.WEBHOOK_MAX_STORED_UNVERIFIED },
    ai: { provider: e.AI_PROVIDER, model: e.AI_MODEL, apiKey: e.AI_API_KEY, baseUrl: e.AI_BASE_URL },
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    secrets: [e.PAYPAL_CLIENT_SECRET, e.AI_API_KEY, e.PAYPAL_WEBHOOK_ID].filter((s): s is string => !!s),
  };
}

/** Explicit PostgreSQL entry point. Legacy callers still fail closed on DSNs. */
export function loadPostgresConfig(env: Record<string,string | undefined>) {
  const e = validateEnvironment(env);
  let database: URL;
  try { database = new URL(e.DATABASE_URL); } catch { throw new ConfigError("PostgreSQL configuration required",["DATABASE_URL"]); }
  if (!["postgres:","postgresql:"].includes(database.protocol) || !database.hostname || !database.username || !database.password) throw new ConfigError("PostgreSQL credentials and host required",["DATABASE_URL"]);
  const hosted = z.object({ APP_ORIGIN: z.string().url(),AUTH_SECRET: z.string().min(32),OWNER_USER_ID: optionalString,
    APP_SOURCE_ATTEMPT_ID: optionalString,AI_DAILY_LIMIT: z.coerce.number().int().min(0).max(200).default(60),AI_USER_DAILY_LIMIT: z.coerce.number().int().min(0).max(10).default(3),
  }).safeParse(env);
  if (!hosted.success) { const keys = [...new Set(hosted.error.issues.map(i => String(i.path[0])))]; throw new ConfigError("Invalid hosted application configuration",keys); }
  const origin = new URL(hosted.data.APP_ORIGIN);
  if (!["http:","https:"].includes(origin.protocol) || origin.origin !== hosted.data.APP_ORIGIN || (!['127.0.0.1','localhost','[::1]'].includes(origin.hostname) && origin.protocol !== 'https:')) throw new ConfigError("Application origin must be HTTPS or loopback",["APP_ORIGIN"]);
  return { ...sharedConfig(e),databaseUrl: e.DATABASE_URL,origin: origin.origin,authSecret: hosted.data.AUTH_SECRET,
    ownerIds: new Set(hosted.data.OWNER_USER_ID ? [hosted.data.OWNER_USER_ID] : []),sourceAttemptId: hosted.data.APP_SOURCE_ATTEMPT_ID ?? null,
    aiDailyLimit: hosted.data.AI_DAILY_LIMIT,aiUserDailyLimit: hosted.data.AI_USER_DAILY_LIMIT,
    secrets: [...sharedConfig(e).secrets,e.DATABASE_URL,hosted.data.AUTH_SECRET] };
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
