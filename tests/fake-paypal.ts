/**
 * IN-MEMORY FAKE of the PayPal Orders v2 surface used by tests. Results from this fake are
 * MOCKED and must never be reported as Sandbox executions.
 */
import { createHmac } from "node:crypto";
import { crc32 } from "node:zlib";
import type { FetchLike } from "../src/paypal/client.ts";

/** Key of the FAKE webhook signer (tests only). Real PayPal signs with RSA; this only proves byte preservation. */
export const FAKE_WEBHOOK_SIGNING_KEY = "fake-webhook-signing-key-tests-only";

/** Same signed string PayPal documents (id|time|webhook id|CRC32 of the raw body), HMAC'd with a fake key. */
export function fakeWebhookSignature(transmissionId: string, transmissionTime: string, webhookId: string, rawBody: string) {
  const msg = `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(Buffer.from(rawBody, "utf8")) >>> 0}`;
  return createHmac("sha256", FAKE_WEBHOOK_SIGNING_KEY).update(msg).digest("base64");
}

export type WebhookVerifyMode = "signed" | "SUCCESS" | "FAILURE" | "hang" | "hang_ignoring_abort" | "500" | "400" | "malformed" | "network";

type FakeOrder = { id: string; status: string; body: any; captures: any[] };

export class FakePayPal {
  orders = new Map<string, FakeOrder>();
  calls: Array<{ origin: string; method: string; path: string; headers: Record<string, string>; body: string | undefined }> = [];
  captureRequestIds = new Map<string, unknown>();
  /** Programmable faults keyed by operation. */
  faults: Partial<Record<"token" | "create" | "capture" | "get", "401" | "500" | "422" | "timeout" | "network" | "500-after-apply">> = {};
  captureStatus = "COMPLETED";
  captureAmountOverride: string | undefined;
  /** undefined: echo the request's custom_id; null: omit custom_id from views; string: replace it. */
  customIdOverride: string | null | undefined;
  /** Awaited after a capture request is recorded and before it is processed (race tests). */
  beforeCaptureApply: (() => Promise<void> | void) | undefined;
  /** Called after the provider applied a capture, before the response is returned (DB-fault tests). */
  afterCaptureApply: (() => void) | undefined;
  /** verify-webhook-signature behaviour. "signed": SUCCESS only if the fake signature over the embedded raw event matches. */
  webhookVerify: WebhookVerifyMode = "signed";
  /** Webhook id registered at the fake "PayPal" (the postback must carry it). */
  registeredWebhookId: string | undefined;
  verifyCalls: Array<{ webhookId: unknown; transmissionId: unknown; rawEvent: string }> = [];
  #n = 0;

  approve(orderId: string) {
    const o = this.orders.get(orderId);
    if (!o) throw new Error("no such order");
    o.status = "APPROVED";
  }

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const body = typeof init.body === "string" ? init.body : undefined;
    this.calls.push({ origin: u.origin, method, path: u.pathname, headers, body });
    const json = (status: number, b: unknown) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "paypal-debug-id": `dbg${++this.#n}` } });
    const fault = (op: keyof FakePayPal["faults"]) => {
      const f = this.faults[op];
      if (!f) return null;
      if (f === "timeout") {
        const e = new Error("timed out");
        e.name = "TimeoutError";
        throw e;
      }
      if (f === "network") throw new TypeError("fetch failed");
      if (f === "401") return json(401, { error: "invalid_client", error_description: "Client Authentication failed" });
      if (f === "500") return json(500, { name: "INTERNAL_SERVER_ERROR" });
      if (f === "422") return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] });
      return null;
    };

    if (u.pathname === "/v1/oauth2/token") {
      const f = fault("token");
      if (f) return f;
      return json(200, { access_token: "A21AAfake-token-value-that-must-never-be-logged-xxxxxxxx", expires_in: 32400, app_id: "APP-FAKE", scope: "a b c" });
    }
    if (!headers.Authorization?.startsWith("Bearer ")) return json(401, { error: "invalid_token" });

    if (u.pathname === "/v2/checkout/orders" && method === "POST") {
      const f = fault("create");
      if (f) return f;
      const req = JSON.parse(body ?? "{}");
      const id = `FAKE${String(++this.#n).padStart(13, "0")}`;
      const o: FakeOrder = { id, status: "CREATED", body: req, captures: [] };
      this.orders.set(id, o);
      return json(201, { id, status: "CREATED", links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
    }
    const cap = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(u.pathname);
    if (cap && method === "POST") {
      const o = this.orders.get(cap[1]!);
      if (!o) return json(404, { name: "RESOURCE_NOT_FOUND" });
      if (this.beforeCaptureApply) await this.beforeCaptureApply();
      const rid = headers["PayPal-Request-Id"];
      if (rid && this.captureRequestIds.has(rid)) return json(201, this.captureRequestIds.get(rid));
      const f = this.faults.capture;
      if (f === "500-after-apply") {
        this.#applyCapture(o);
        if (rid) this.captureRequestIds.set(rid, this.#view(o));
        this.afterCaptureApply?.();
        return json(500, { name: "INTERNAL_SERVER_ERROR" });
      }
      const ff = fault("capture");
      if (ff) return ff;
      if (o.status === "COMPLETED") return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] });
      if (o.status !== "APPROVED") return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] });
      this.#applyCapture(o);
      const v = this.#view(o);
      if (rid) this.captureRequestIds.set(rid, v);
      this.afterCaptureApply?.();
      return json(201, v);
    }
    const get = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(u.pathname);
    if (get && method === "GET") {
      const f = fault("get");
      if (f) return f;
      const o = this.orders.get(get[1]!);
      if (!o) return json(404, { name: "RESOURCE_NOT_FOUND" });
      return json(200, this.#view(o));
    }
    if (u.pathname === "/v1/notifications/verify-webhook-signature" && method === "POST") return this.#verifyWebhook(body ?? "", init.signal ?? undefined, json);
    return json(404, { name: "NOT_FOUND" });
  };

  async #verifyWebhook(body: string, signal: AbortSignal | undefined, json: (s: number, b: unknown) => Response): Promise<Response> {
    const marker = ',"webhook_event":';
    const at = body.indexOf(marker);
    const rawEvent = at >= 0 && body.endsWith("}") ? body.slice(at + marker.length, -1) : "";
    let pb: Record<string, unknown> = {};
    try {
      pb = JSON.parse(body);
    } catch {
      return json(400, { name: "INVALID_REQUEST" });
    }
    this.verifyCalls.push({ webhookId: pb.webhook_id, transmissionId: pb.transmission_id, rawEvent });
    switch (this.webhookVerify) {
      case "SUCCESS":
      case "FAILURE":
        return json(200, { verification_status: this.webhookVerify });
      case "500":
        return json(500, { name: "INTERNAL_SERVER_ERROR" });
      case "400":
        return json(400, { name: "VALIDATION_ERROR" });
      case "malformed":
        return json(200, { verification_status: "MAYBE" });
      case "network":
        throw new TypeError("fetch failed");
      case "hang":
        return new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      case "hang_ignoring_abort":
        return new Promise<Response>(() => {});
      case "signed": {
        const ok =
          typeof pb.webhook_id === "string" &&
          pb.webhook_id === this.registeredWebhookId &&
          typeof pb.transmission_id === "string" &&
          typeof pb.transmission_time === "string" &&
          pb.auth_algo === "SHA256withRSA" &&
          pb.transmission_sig === fakeWebhookSignature(pb.transmission_id, pb.transmission_time, pb.webhook_id, rawEvent);
        return json(200, { verification_status: ok ? "SUCCESS" : "FAILURE" });
      }
    }
  }

  /** Capture id the fake assigns to an order (deterministic). */
  static captureIdFor(orderId: string) {
    return `CAP${orderId.slice(-10)}`;
  }

  #applyCapture(o: FakeOrder) {
    const pu = o.body.purchase_units[0];
    o.captures.push({ id: `CAP${o.id.slice(-10)}`, status: this.captureStatus, final_capture: true, amount: { currency_code: pu.amount.currency_code, value: this.captureAmountOverride ?? pu.amount.value } });
    o.status = this.captureStatus === "COMPLETED" ? "COMPLETED" : o.status === "APPROVED" ? "COMPLETED" : o.status;
  }

  #view(o: FakeOrder) {
    const pu = o.body.purchase_units[0];
    return {
      id: o.id,
      status: o.status,
      intent: o.body.intent,
      payer: { email_address: "buyer@example.com", name: { given_name: "Test", surname: "Buyer" } },
      purchase_units: [
        {
          reference_id: pu.reference_id,
          custom_id: this.customIdOverride === undefined ? pu.custom_id : (this.customIdOverride ?? undefined),
          amount: pu.amount,
          payee: { merchant_id: "MERCHANTFAKE123", email_address: "seller@example.com" },
          ...(o.captures.length ? { payments: { captures: o.captures } } : {}),
        },
      ],
    };
  }
}

export const testPaypalConfig = {
  env: "sandbox" as const,
  apiBase: "https://api-m.sandbox.paypal.com" as const,
  clientId: "test-client-id",
  clientSecret: "test-client-secret-SHOULD-NOT-LEAK",
  webhookId: undefined,
  timeoutMs: 2000,
};

/** Number of capture POSTs the fake received (each one is a potential provider write). */
export const capturePosts = (fake: FakePayPal) => fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/capture"));

export const newCheckoutKey = () => `ck_${crypto.randomUUID().replace(/-/g, "")}`;

export const silentLogger = () => {
  const lines: string[] = [];
  const w = (obj: object, msg?: string) => void lines.push(JSON.stringify({ msg, ...obj }));
  return { lines, info: w, warn: w, error: w };
};
