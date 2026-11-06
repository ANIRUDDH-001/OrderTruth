/** Isolated Sandbox experiment client. No environment loading or automatic startup. */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PayPalClient, type CallMeta, type FetchLike, type PayPalCall } from "../paypal/client.ts";
import type { OrderReadback } from "../domain/checkout.ts";

const API = "https://api-m.sandbox.paypal.com" as const;
// Captured once. Replacing a global fetch later cannot redirect an already trusted factory.
const nativeFetch = globalThis.fetch.bind(globalThis);
const limits = Object.freeze({ oauth: 3, createOrder: 1, captureOrder: 1, getOrder: 12, verifySignature: 5, getWebhook: 1, createWebhook: 1, deleteWebhook: 1 });
type Operation = keyof typeof limits;
type Credentials = { clientId: string; clientSecret: string };
type Options = { budgetFile: string; registrationMode: "reuse" | "temporary" };
export type LabBudgetSnapshot = { counts: Record<Operation, number>; total: number; maximum: 23 | 25 };
export type LabRequestEvidence = { operation: Operation; httpStatus: number | null; debugId: string | null; outcome: "response" | "transport_error" | "redirect_rejected" };
export type LabSandboxClient = Readonly<{
  apiBase: typeof API;
  checkAuth: PayPalClient["checkAuth"];
  createOrder: PayPalClient["createOrder"];
  captureOrder: PayPalClient["captureOrder"];
  verifyWebhookSignature: PayPalClient["verifyWebhookSignature"];
  getWebhook: PayPalClient["getWebhook"];
  getOrder(orderId: string, meta: CallMeta): Promise<PayPalCall<OrderReadback>>;
  createWebhook(body: { url: string; event_types: Array<{ name: string }> }, meta: CallMeta): Promise<PayPalCall<{ id?: unknown; url?: unknown; event_types?: unknown }>>;
  deleteWebhook(webhookId: string, meta: CallMeta): Promise<PayPalCall<unknown>>;
  budgetSnapshot(): LabBudgetSnapshot;
  requestEvidence(): LabRequestEvidence[];
}>;
const live = new WeakSet<object>();
const offline = new WeakSet<object>();
const underlying = new WeakMap<object, PayPalClient>();

export function isLabSandboxClient(value: unknown): value is LabSandboxClient {
  return typeof value === "object" && value !== null && live.has(value);
}
export function assertLabSandboxClient(value: unknown): asserts value is LabSandboxClient {
  if (!isLabSandboxClient(value)) throw new Error("lab client: trusted Sandbox client required");
}
export function labClientAuthority(value: unknown): "PAYPAL" | "TEST" {
  if (isLabSandboxClient(value)) return "PAYPAL";
  if (typeof value === "object" && value !== null && offline.has(value)) return "TEST";
  throw new Error("lab client: unrecognized client authority");
}
/** Same transport/budget instance, for existing nominal PayPalClient constructor types. */
export function getLabSandboxPayPalClient(value: unknown): PayPalClient {
  assertLabSandboxClient(value);
  return underlying.get(value)!;
}

function strictRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("lab client: invalid configuration");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !descriptors[key] || !("value" in descriptors[key]!))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))) throw new Error("lab client: unsupported configuration fields");
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}
function config(credentials: unknown, options: unknown): { credentials: Credentials; options: Options } {
  const c = strictRecord(credentials, ["clientId", "clientSecret"]);
  const o = strictRecord(options, ["budgetFile", "registrationMode"]);
  if (![c.clientId, c.clientSecret].every((value) => typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\r\n]/.test(value))) throw new Error("lab client: invalid credentials");
  if (typeof o.budgetFile !== "string" || !o.budgetFile.endsWith(".jsonl") || !o.budgetFile.length
    || (o.registrationMode !== "reuse" && o.registrationMode !== "temporary")) throw new Error("lab client: invalid budget configuration");
  return { credentials: c as Credentials, options: { budgetFile: resolve(o.budgetFile), registrationMode: o.registrationMode } };
}

/** Append + fsync before outbound request; a crash leaves spent capacity, never refunds it. */
function budget(options: Options) {
  const maximum = options.registrationMode === "reuse" ? 23 : 25;
  const zero = (): LabBudgetSnapshot => ({ counts: Object.fromEntries(Object.keys(limits).map((key) => [key, 0])) as Record<Operation, number>, total: 0, maximum });
  const header = JSON.stringify({ version: 1, registrationMode: options.registrationMode });
  function snapshot(): LabBudgetSnapshot {
    if (!existsSync(options.budgetFile)) return zero();
    if (statSync(options.budgetFile).size > 16_384) throw new Error("lab client: oversized budget journal");
    const text = readFileSync(options.budgetFile, "utf8");
    if (!text.endsWith("\n")) throw new Error("lab client: incomplete budget journal; review required");
    const lines = text.trimEnd().split("\n");
    if (lines.shift() !== header) throw new Error("lab client: budget policy mismatch");
    const state = zero();
    for (const line of lines) {
      let entry: { seq?: unknown; operation?: unknown };
      try { entry = JSON.parse(line) as typeof entry; } catch { throw new Error("lab client: corrupt budget journal"); }
      if (!entry || Object.keys(entry).sort().join(",") !== "operation,seq" || entry.seq !== state.total + 1 || typeof entry.operation !== "string" || !Object.hasOwn(limits, entry.operation)) throw new Error("lab client: corrupt budget journal");
      const operation = entry.operation as Operation;
      state.counts[operation]++; state.total++;
      if (state.counts[operation] > allowed(operation) || state.total > maximum) throw new Error("lab client: invalid budget journal counts");
    }
    return state;
  }
  function allowed(operation: Operation) { return options.registrationMode === "reuse" && ["createWebhook", "deleteWebhook"].includes(operation) ? 0 : limits[operation]; }
  function precheck(operation: Operation) {
    const state = snapshot();
    if (state.total >= maximum || state.counts[operation] >= allowed(operation)) throw new Error(`lab client: ${operation} request budget exhausted`);
  }
  function reserve(operation: Operation) {
    mkdirSync(dirname(options.budgetFile), { recursive: true });
    let lock: number;
    try { lock = openSync(options.budgetFile + ".lock", "wx", 0o600); } catch { throw new Error("lab client: budget locked; review required"); }
    try {
      const state = snapshot();
      if (state.total >= maximum || state.counts[operation] >= allowed(operation)) throw new Error(`lab client: ${operation} request budget exhausted`);
      const file = openSync(options.budgetFile, "a", 0o600);
      try {
        if (state.total === 0 && !readFileSync(options.budgetFile, "utf8").length) writeSync(file, header + "\n");
        writeSync(file, JSON.stringify({ seq: state.total + 1, operation }) + "\n");
        fsyncSync(file);
      } finally { closeSync(file); }
    } finally { closeSync(lock); unlinkSync(options.budgetFile + ".lock"); }
  }
  // Read now so a restarted bootstrap fails closed before accepting any requests.
  snapshot();
  return { snapshot, reserve, precheck };
}
function operationFor(url: string, method: string): Operation {
  const target = new URL(url);
  if (target.origin !== API || target.search || target.hash || target.username || target.password) throw new Error("lab client: forbidden request target");
  const path = target.pathname;
  if (method === "POST" && path === "/v1/oauth2/token") return "oauth";
  if (method === "POST" && path === "/v2/checkout/orders") return "createOrder";
  if (method === "POST" && /^\/v2\/checkout\/orders\/[A-Za-z0-9_-]+\/capture$/.test(path)) return "captureOrder";
  if (method === "GET" && /^\/v2\/checkout\/orders\/[A-Za-z0-9_-]+$/.test(path)) return "getOrder";
  if (method === "POST" && path === "/v1/notifications/verify-webhook-signature") return "verifySignature";
  if (method === "POST" && path === "/v1/notifications/webhooks") return "createWebhook";
  if (/^\/v1\/notifications\/webhooks\/[A-Za-z0-9_-]+$/.test(path)) {
    if (method === "GET") return "getWebhook";
    if (method === "DELETE") return "deleteWebhook";
  }
  throw new Error("lab client: unsupported provider operation");
}

function construct(credentials: Credentials, options: Options, transport: FetchLike, authority: "PAYPAL" | "TEST"): LabSandboxClient {
  const meter = budget(options);
  const evidence: LabRequestEvidence[] = [];
  const sensitive = new Set([credentials.clientId, credentials.clientSecret]);
  let evidenceFailed = false;
  const evidenceError = () => Object.assign(new Error("lab client: evidence persistence failed; request budget consumed; review required"), { outcomeUnknown: true });
  function recordEvidence(entry: LabRequestEvidence) {
    evidence.push(entry);
    let file: number | undefined;
    try {
      file = openSync(options.budgetFile + ".evidence.jsonl", "a", 0o600);
      const bytes = Buffer.from(JSON.stringify(entry) + "\n", "utf8");
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(file, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error("evidence write failed");
        offset += written;
      }
      fsyncSync(file);
    } catch { evidenceFailed = true; throw evidenceError(); }
    finally { if (file !== undefined) closeSync(file); }
  }
  const constrained: FetchLike = async (url, init) => {
    if (evidenceFailed) throw evidenceError();
    const operation = operationFor(url, init.method ?? "GET");
    meter.reserve(operation);
    let response: Response;
    try { response = await transport(url, { ...init, redirect: "error" }); }
    catch (error) {
      recordEvidence({ operation, httpStatus: null, debugId: null, outcome: "transport_error" });
      const safe = new Error("lab client: transport failed; request budget consumed");
      if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) safe.name = error.name;
      throw safe;
    }
    if (operation === "oauth" && response.ok) {
      const auth = await response.clone().json().catch(() => null) as { access_token?: unknown } | null;
      if (auth && typeof auth.access_token === "string" && auth.access_token.length > 0) sensitive.add(auth.access_token);
    }
    const debug = response.headers.get("paypal-debug-id");
    const safeDebug = debug && /^[A-Za-z0-9_-]{1,128}$/.test(debug) && ![...sensitive].some((secret) => debug.includes(secret)) ? debug : null;
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      recordEvidence({ operation, httpStatus: response.status, debugId: safeDebug, outcome: "redirect_rejected" });
      throw new Error("lab client: redirect forbidden; request budget consumed");
    }
    recordEvidence({ operation, httpStatus: response.status, debugId: safeDebug, outcome: "response" });
    const headers = new Headers(response.headers); headers.delete("paypal-debug-id"); if (safeDebug) headers.set("paypal-debug-id", safeDebug);
    // Error payloads are never propagated: arbitrary provider text is not safe diagnostic metadata.
    if (!response.ok) return new Response(JSON.stringify({ name: "SANDBOX_HTTP_ERROR" }), { status: response.status, headers });
    return new Response(response.body, { status: response.status, headers });
  };
  const paypal = new PayPalClient({ env: "sandbox", apiBase: API, ...credentials, webhookId: undefined, timeoutMs: 15_000 }, constrained);
  // Both the branded surface and nominal-client unwrap refuse an exhausted target
  // operation before PayPalClient can obtain a new OAuth token after restart.
  function prechecked<A extends unknown[], R>(operation: Operation, call: (...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      if (evidenceFailed) throw evidenceError();
      meter.precheck(operation);
      try { return await call(...args); } catch (error) { if (evidenceFailed) throw evidenceError(); throw error; }
    };
  }
  paypal.checkAuth = prechecked("oauth", paypal.checkAuth.bind(paypal));
  paypal.createOrder = prechecked("createOrder", paypal.createOrder.bind(paypal));
  paypal.captureOrder = prechecked("captureOrder", paypal.captureOrder.bind(paypal));
  paypal.getOrder = prechecked("getOrder", paypal.getOrder.bind(paypal));
  paypal.getWebhook = prechecked("getWebhook", paypal.getWebhook.bind(paypal));
  paypal.verifyWebhookSignature = prechecked("verifySignature", paypal.verifyWebhookSignature.bind(paypal));
  Object.freeze(paypal);
  // Registration management has no generic public request method and never exposes OAuth tokens.
  let registrationToken: { token: string; expires: number } | undefined;
  async function registration(method: "POST" | "DELETE", path: string, body: unknown, meta: CallMeta): Promise<PayPalCall<unknown>> {
    if (evidenceFailed) throw evidenceError();
    if (options.registrationMode !== "temporary") throw new Error("lab client: registration mutation not authorized by budget policy");
    meter.precheck(method === "POST" ? "createWebhook" : "deleteWebhook");
    if (!registrationToken || registrationToken.expires <= Date.now() + 60_000) {
      const response = await constrained(API + "/v1/oauth2/token", { method: "POST", headers: { Authorization: "Basic " + Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("lab client: registration authentication failed");
      const data = await response.json() as { access_token?: unknown; expires_in?: unknown };
      if (typeof data.access_token !== "string" || !data.access_token.length) throw new Error("lab client: invalid registration authentication response");
      registrationToken = { token: data.access_token, expires: Date.now() + (typeof data.expires_in === "number" ? Math.max(0, Math.min(data.expires_in, 3600)) : 300) * 1000 };
    }
    const started = performance.now();
    const response = await constrained(API + path, { method, headers: { Authorization: `Bearer ${registrationToken.token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`lab client: registration HTTP ${response.status}`);
    const text = await response.text();
    return { body: text ? JSON.parse(text) : null, httpStatus: response.status, debugId: response.headers.get("paypal-debug-id"), durationMs: Math.round(performance.now() - started), requestId: null, correlationId: meta.correlationId };
  }
  const client: LabSandboxClient = Object.freeze({ apiBase: API, checkAuth: paypal.checkAuth.bind(paypal), createOrder: paypal.createOrder.bind(paypal), captureOrder: paypal.captureOrder.bind(paypal), getOrder: paypal.getOrder.bind(paypal) as LabSandboxClient["getOrder"], verifyWebhookSignature: paypal.verifyWebhookSignature.bind(paypal), getWebhook: paypal.getWebhook.bind(paypal),
    createWebhook: (body, meta) => registration("POST", "/v1/notifications/webhooks", body, meta) as ReturnType<LabSandboxClient["createWebhook"]>,
    deleteWebhook: (id, meta) => registration("DELETE", `/v1/notifications/webhooks/${encodeURIComponent(id)}`, undefined, meta), budgetSnapshot: meter.snapshot,
    requestEvidence: () => evidence.map((entry) => ({ ...entry })) });
  (authority === "PAYPAL" ? live : offline).add(client); underlying.set(client, paypal);
  return client;
}

export function createLabSandboxClient(credentials: Credentials, options: Options): LabSandboxClient {
  if (arguments.length !== 2) throw new Error("lab client: unsupported factory arguments");
  const checked = config(credentials, options);
  return construct(checked.credentials, checked.options, nativeFetch, "PAYPAL");
}
/** Explicit OFFLINE seam: cannot mint PAYPAL authority or pass the live assertion/unwrap. */
export function createOfflineLabSandboxClientForTest(credentials: Credentials, options: Options, transport: FetchLike): LabSandboxClient {
  const checked = config(credentials, options);
  return construct(checked.credentials, checked.options, transport, "TEST");
}
