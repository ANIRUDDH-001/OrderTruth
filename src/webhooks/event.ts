import { z } from "zod";

/**
 * Validation of untrusted webhook input (headers + body) before any PayPal postback. Nothing here
 * establishes authenticity: only PayPal's verify-webhook-signature SUCCESS does. These checks only
 * bound what we forward and store, and reject obviously malformed or replayed requests early.
 */

/** Sandbox certificate hosts. PayPal fetches the certificate; OrderTruth never does (postback). */
const CERT_HOSTS = new Set(["api.sandbox.paypal.com", "api-m.sandbox.paypal.com"]);
/** The only algorithm PayPal documents for webhook signatures. Anything else fails closed. */
export const AUTH_ALGOS = new Set(["SHA256withRSA"]);

// Patterns and lengths from the verify-webhook-signature request schema (Webhooks v1).
const TRANSMISSION_ID = /^(?!\d+$)\w+\S+$/;
const TRANSMISSION_SIG = /^[A-Za-z0-9+/=_-]{16,500}$/;

export type TransmissionHeaders = {
  transmissionId: string;
  transmissionTime: string;
  transmissionTimeMs: number;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
};

export type Rejection = { reason: string };

function single(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const v = headers[name];
  return typeof v === "string" && v.length > 0 ? v : null; // repeated headers (arrays) are rejected
}

export function parseTransmissionHeaders(headers: Record<string, string | string[] | undefined>): TransmissionHeaders | Rejection {
  const transmissionId = single(headers, "paypal-transmission-id");
  const transmissionTime = single(headers, "paypal-transmission-time");
  const transmissionSig = single(headers, "paypal-transmission-sig");
  const certUrl = single(headers, "paypal-cert-url");
  const authAlgo = single(headers, "paypal-auth-algo");
  const missing = [
    ["paypal-transmission-id", transmissionId],
    ["paypal-transmission-time", transmissionTime],
    ["paypal-transmission-sig", transmissionSig],
    ["paypal-cert-url", certUrl],
    ["paypal-auth-algo", authAlgo],
  ].filter(([, v]) => v === null);
  if (missing.length) return { reason: `missing_headers:${missing.map(([k]) => k).join(",")}` };
  if (transmissionId!.length > 50 || !TRANSMISSION_ID.test(transmissionId!)) return { reason: "invalid_transmission_id" };
  if (!TRANSMISSION_SIG.test(transmissionSig!)) return { reason: "invalid_transmission_sig" };
  if (!AUTH_ALGOS.has(authAlgo!)) return { reason: "unsupported_auth_algo" };
  if (transmissionTime!.length > 100) return { reason: "invalid_transmission_time" };
  const t = Date.parse(transmissionTime!);
  if (!Number.isFinite(t) || !/^\d{4}-\d{2}-\d{2}T/.test(transmissionTime!)) return { reason: "invalid_transmission_time" };
  if (!isAllowedCertUrl(certUrl!)) return { reason: "cert_url_not_allowed" };
  return { transmissionId: transmissionId!, transmissionTime: transmissionTime!, transmissionTimeMs: t, transmissionSig: transmissionSig!, certUrl: certUrl!, authAlgo: authAlgo! };
}

/** Defence in depth only: the URL is forwarded to PayPal for its own check and never fetched here. */
export function isAllowedCertUrl(raw: string): boolean {
  if (raw.length > 500) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === "https:" && CERT_HOSTS.has(u.hostname) && u.port === "" && !u.username && !u.password && !u.search && !u.hash && u.pathname.startsWith("/v1/notifications/certs/");
}

const Amount = z.object({ currency_code: z.string().max(3), value: z.string().max(32) }).partial();

/** Structure required before we spend a postback on a request. Unknown fields are allowed (PayPal adds fields). */
export const EventSchema = z.object({
  id: z.string().regex(/^WH-[A-Za-z0-9-]{6,100}$/),
  event_type: z.string().max(100).regex(/^[A-Z0-9_]+(\.[A-Z0-9_]+){1,5}$/),
  resource_type: z.string().max(64).optional(),
  event_version: z.string().max(16).optional(),
  resource_version: z.string().max(16).optional(),
  create_time: z.string().max(40).optional(),
  summary: z.string().max(500).optional(),
  resource: z.record(z.string(), z.unknown()),
});
export type WebhookEvent = z.infer<typeof EventSchema>;

/**
 * Allowlisted, PII-free projection of an event: the only part of a body that is ever stored.
 * Payer, payee, addresses, emails, links and free text are dropped.
 */
export type EventSummary = {
  id: string;
  event_type: string;
  resource_type: string | null;
  event_version: string | null;
  resource_version: string | null;
  create_time: string | null;
  resource: {
    id: string | null;
    status: string | null;
    amount: { currency_code: string | null; value: string | null } | null;
    custom_id: string | null;
    /** Capture events: supplementary_data.related_ids.order_id. Order events: resource.id. */
    order_id: string | null;
  };
};

const str = (v: unknown, max = 64): string | null => (typeof v === "string" && v.length <= max ? v : null);

function amountOf(v: unknown) {
  const p = Amount.safeParse(v);
  if (!p.success || v === undefined) return null;
  return { currency_code: str(p.data.currency_code, 3), value: str(p.data.value, 32) };
}

export function summarizeEvent(e: WebhookEvent): EventSummary {
  const r = e.resource;
  const isOrder = e.event_type.startsWith("CHECKOUT.ORDER.");
  const unit = Array.isArray(r.purchase_units) ? (r.purchase_units[0] as Record<string, unknown> | undefined) : undefined;
  const related = ((r.supplementary_data as Record<string, unknown> | undefined)?.related_ids ?? {}) as Record<string, unknown>;
  return {
    id: e.id,
    event_type: e.event_type,
    resource_type: e.resource_type ?? null,
    event_version: e.event_version ?? null,
    resource_version: e.resource_version ?? null,
    create_time: e.create_time ?? null,
    resource: {
      id: str(r.id),
      status: str(r.status, 32),
      amount: amountOf(isOrder ? unit?.amount : r.amount),
      custom_id: str(isOrder ? unit?.custom_id : r.custom_id, 127),
      order_id: isOrder ? str(r.id) : str(related.order_id),
    },
  };
}

/** Best-effort, length/charset-bounded hints from an unverified body, for delivery bookkeeping only. */
export function claimedIdentity(parsed: unknown): { id: string | null; type: string | null } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { id: null, type: null };
  const o = parsed as Record<string, unknown>;
  const id = typeof o.id === "string" && /^[A-Za-z0-9-]{1,100}$/.test(o.id) ? o.id : null;
  const type = typeof o.event_type === "string" && /^[A-Z0-9_.]{1,100}$/.test(o.event_type) ? o.event_type : null;
  return { id, type };
}
