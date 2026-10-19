import { SANDBOX_API_BASE, type AppConfig } from "../config.ts";
import { redactString } from "../redact.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type PayPalErrorKind =
  | "auth_failed" // 401 / invalid_client
  | "forbidden" // 403
  | "not_found" // 404
  | "unprocessable" // 422, e.g. ORDER_NOT_APPROVED
  | "client_error" // other 4xx
  | "server_error" // 5xx: outcome UNKNOWN for writes
  | "timeout" // outcome UNKNOWN for writes
  | "network"; // outcome UNKNOWN for writes

export class PayPalError extends Error {
  readonly kind: PayPalErrorKind;
  readonly httpStatus: number | null;
  readonly debugId: string | null;
  /** PayPal error `name`/`details[].issue` codes only; no payloads. */
  readonly issues: string[];
  readonly durationMs: number;
  constructor(kind: PayPalErrorKind, message: string, meta: { httpStatus: number | null; debugId: string | null; issues: string[]; durationMs: number }) {
    super(message);
    this.name = "PayPalError";
    this.kind = kind;
    this.httpStatus = meta.httpStatus;
    this.debugId = meta.debugId;
    this.issues = meta.issues;
    this.durationMs = meta.durationMs;
  }
  /** For writes: true means the provider may or may not have applied the operation. */
  get outcomeUnknown(): boolean {
    return this.kind === "server_error" || this.kind === "timeout" || this.kind === "network";
  }
}

export type PayPalCall<T> = {
  body: T;
  httpStatus: number;
  debugId: string | null;
  durationMs: number;
  requestId: string | null;
  correlationId: string;
};

export type CallMeta = { correlationId: string };

function classify(status: number): PayPalErrorKind {
  if (status === 401) return "auth_failed";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 422) return "unprocessable";
  if (status >= 500) return "server_error";
  return "client_error";
}

function extractIssues(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const b = body as { name?: unknown; error?: unknown; details?: Array<{ issue?: unknown }> };
  const out: string[] = [];
  if (typeof b.name === "string") out.push(b.name);
  if (typeof b.error === "string") out.push(b.error);
  for (const d of b.details ?? []) if (typeof d?.issue === "string") out.push(d.issue);
  return out.slice(0, 10);
}

/**
 * Thin, Sandbox-only Orders v2 REST client. The client secret and access token never leave
 * this object: they are not logged, not returned, not included in errors.
 */
export class PayPalClient {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;
  #token: { value: string; expiresAt: number } | null = null;

  constructor(cfg: AppConfig["paypal"], fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)) {
    if (cfg.apiBase !== SANDBOX_API_BASE || cfg.env !== "sandbox") {
      throw new Error("PayPalClient refuses non-Sandbox configuration");
    }
    this.#clientId = cfg.clientId;
    this.#clientSecret = cfg.clientSecret;
    this.#timeoutMs = cfg.timeoutMs;
    this.#fetch = fetchImpl;
  }

  async #request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { meta: CallMeta; body?: unknown; rawJson?: string; requestId?: string; auth?: "basic" | "bearer"; form?: string; timeoutMs?: number },
  ): Promise<PayPalCall<T>> {
    const url = SANDBOX_API_BASE + path; // host is a constant; only the path varies
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.auth === "basic") {
      headers.Authorization = "Basic " + Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString("base64");
    } else {
      headers.Authorization = `Bearer ${await this.#accessToken(opts.meta)}`;
    }
    let payload: string | undefined;
    if (opts.form !== undefined) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      payload = opts.form;
    } else if (opts.rawJson !== undefined) {
      // Pre-serialized JSON (webhook postback embeds the event bytes exactly as received).
      headers["Content-Type"] = "application/json";
      payload = opts.rawJson;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers.Prefer = "return=representation";
      payload = JSON.stringify(opts.body);
    }
    if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;

    const started = performance.now();
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.#timeoutMs),
      });
    } catch (err) {
      const durationMs = Math.round(performance.now() - started);
      const name = (err as Error)?.name;
      const kind: PayPalErrorKind = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
      throw new PayPalError(kind, `${method} ${path} ${kind}`, { httpStatus: null, debugId: null, issues: [], durationMs });
    }
    const durationMs = Math.round(performance.now() - started);
    const debugId = res.headers.get("paypal-debug-id");
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const kind = classify(res.status);
      const issues = extractIssues(body).map((i) => redactString(i, [this.#clientSecret]));
      throw new PayPalError(kind, `${method} ${path} -> HTTP ${res.status}${issues.length ? ` (${issues.join(",")})` : ""}`, {
        httpStatus: res.status,
        debugId,
        issues,
        durationMs,
      });
    }
    return { body: body as T, httpStatus: res.status, debugId, durationMs, requestId: opts.requestId ?? null, correlationId: opts.meta.correlationId };
  }

  async #accessToken(meta: CallMeta): Promise<string> {
    if (this.#token && this.#token.expiresAt > Date.now() + 60_000) return this.#token.value;
    const r = await this.#request<{ access_token?: string; expires_in?: number; app_id?: string }>("POST", "/v1/oauth2/token", {
      meta,
      auth: "basic",
      form: "grant_type=client_credentials",
    });
    const tok = r.body?.access_token;
    if (!tok) throw new PayPalError("auth_failed", "OAuth response lacked access_token", { httpStatus: r.httpStatus, debugId: r.debugId, issues: [], durationMs: r.durationMs });
    this.#token = { value: tok, expiresAt: Date.now() + (r.body.expires_in ?? 300) * 1000 };
    return tok;
  }

  /** OAuth proof. Returns only non-sensitive metadata. */
  async checkAuth(meta: CallMeta): Promise<{ httpStatus: number; debugId: string | null; durationMs: number; expiresInSec: number | null; appIdPresent: boolean; scopeCount: number }> {
    this.#token = null;
    const r = await this.#request<{ access_token?: string; expires_in?: number; app_id?: string; scope?: string }>("POST", "/v1/oauth2/token", {
      meta,
      auth: "basic",
      form: "grant_type=client_credentials",
    });
    if (!r.body?.access_token) throw new PayPalError("auth_failed", "OAuth response lacked access_token", { httpStatus: r.httpStatus, debugId: r.debugId, issues: [], durationMs: r.durationMs });
    this.#token = { value: r.body.access_token, expiresAt: Date.now() + (r.body.expires_in ?? 300) * 1000 };
    return {
      httpStatus: r.httpStatus,
      debugId: r.debugId,
      durationMs: r.durationMs,
      expiresInSec: r.body.expires_in ?? null,
      appIdPresent: typeof r.body.app_id === "string",
      scopeCount: (r.body.scope ?? "").split(" ").filter(Boolean).length,
    };
  }

  createOrder(body: unknown, requestId: string, meta: CallMeta) {
    return this.#request<{ id: string; status: string; links?: Array<{ href: string; rel: string; method?: string }> }>("POST", "/v2/checkout/orders", {
      meta,
      body,
      requestId,
    });
  }

  captureOrder(orderId: string, requestId: string, meta: CallMeta) {
    return this.#request<unknown>("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { meta, body: {}, requestId });
  }

  /**
   * Postback signature verification (Webhooks v1). `postbackJson` must already embed the event
   * exactly as received. PayPal checks the signature and certificate; OrderTruth never downloads a
   * certificate. Returns `verification_status` (SUCCESS | FAILURE) as sent by PayPal.
   */
  verifyWebhookSignature(postbackJson: string, meta: CallMeta, timeoutMs: number) {
    return this.#request<{ verification_status?: unknown }>("POST", "/v1/notifications/verify-webhook-signature", { meta, rawJson: postbackJson, timeoutMs });
  }

  /** Read-only: the webhook registration (url, event types) as seen by THIS REST app's credentials. */
  getWebhook(webhookId: string, meta: CallMeta) {
    return this.#request<{ id?: unknown; url?: unknown; event_types?: unknown }>("GET", `/v1/notifications/webhooks/${encodeURIComponent(webhookId)}`, { meta });
  }

  getOrder(orderId: string, meta: CallMeta) {
    return this.#request<unknown>("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`, { meta });
  }
}
