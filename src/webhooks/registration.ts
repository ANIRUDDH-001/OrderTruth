import { PayPalError, type PayPalClient } from "../paypal/client.ts";
import { WEBHOOK_PATH } from "./app.ts";

/** Minimum subscription for the live acceptance test; other handled types are optional. */
export const REQUIRED_EVENT_TYPES = ["PAYMENT.CAPTURE.COMPLETED"] as const;
export const RECOMMENDED_EVENT_TYPES = ["PAYMENT.CAPTURE.COMPLETED", "CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.DENIED"] as const;

export type RegistrationCheck = {
  ok: boolean;
  httpStatus: number | null;
  debugId: string | null;
  expectedUrl: string;
  /** Origin only; the webhook id itself is never printed. */
  registeredOrigin: string | null;
  urlMatches: boolean;
  eventTypes: string[];
  missingRequired: string[];
  missingRecommended: string[];
  problems: string[];
};

/**
 * Read-only preflight (one GET with this app's OAuth): does the configured webhook id exist for
 * THIS Sandbox REST app, point at exactly `<tunnel origin>/webhooks/paypal`, and subscribe to the
 * events the live test needs? A 404 means the id is wrong or belongs to another REST app.
 */
export async function checkWebhookRegistration(paypal: PayPalClient, webhookId: string, tunnelBase: string, correlationId: string): Promise<RegistrationCheck> {
  const problems: string[] = [];
  let expectedUrl = "";
  try {
    const u = new URL(tunnelBase);
    if (u.protocol !== "https:") problems.push("tunnel URL must be https");
    expectedUrl = `${u.origin}${WEBHOOK_PATH}`;
  } catch {
    problems.push("tunnel URL is not a valid URL");
  }
  const base = { expectedUrl, registeredOrigin: null, urlMatches: false, eventTypes: [], missingRequired: [...REQUIRED_EVENT_TYPES], missingRecommended: [...RECOMMENDED_EVENT_TYPES] };
  if (problems.length) return { ok: false, httpStatus: null, debugId: null, problems, ...base };
  try {
    const r = await paypal.getWebhook(webhookId, { correlationId });
    const url = typeof r.body?.url === "string" ? r.body.url : "";
    const types = Array.isArray(r.body?.event_types) ? (r.body.event_types as Array<{ name?: unknown }>).map((t) => (typeof t?.name === "string" ? t.name : "")).filter(Boolean) : [];
    let origin: string | null = null;
    try {
      origin = new URL(url).origin;
    } catch {
      problems.push("registered URL is not a valid URL");
    }
    const urlMatches = url === expectedUrl;
    if (!urlMatches) problems.push("registered URL differs from <tunnel origin>/webhooks/paypal");
    const all = types.includes("*");
    const missingRequired = all ? [] : REQUIRED_EVENT_TYPES.filter((t) => !types.includes(t));
    if (missingRequired.length) problems.push(`not subscribed to ${missingRequired.join(", ")}`);
    const missingRecommended = all ? [] : RECOMMENDED_EVENT_TYPES.filter((t) => !types.includes(t));
    return { ok: problems.length === 0, httpStatus: r.httpStatus, debugId: r.debugId, expectedUrl, registeredOrigin: origin, urlMatches, eventTypes: types, missingRequired, missingRecommended, problems };
  } catch (err) {
    if (err instanceof PayPalError) {
      problems.push(err.httpStatus === 404 ? "webhook id not found for this Sandbox REST app (wrong id, or registered under another app)" : `PayPal lookup failed: ${err.kind}`);
      return { ok: false, httpStatus: err.httpStatus, debugId: err.debugId, problems, ...base };
    }
    throw err;
  }
}
