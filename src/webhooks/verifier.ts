import { PayPalError, type PayPalClient } from "../paypal/client.ts";
import type { TransmissionHeaders } from "./event.ts";

export type VerifyInput = {
  /** The request body exactly as received (UTF-8 text of the raw bytes). Already known to parse as a JSON object. */
  rawBody: string;
  headers: TransmissionHeaders;
  /** From server configuration, never from the request. */
  webhookId: string;
  correlationId: string;
};

export type VerifyResult =
  | { status: "SUCCESS" | "FAILURE"; durationMs: number; debugId: string | null }
  /** PayPal could not give a definitive answer (timeout, network, 4xx/5xx, malformed reply). Never treated as success. */
  | { status: "UNAVAILABLE"; kind: string; durationMs: number; debugId: string | null };

/** Seam for offline tests and a possible later self-verification implementation. */
export interface WebhookVerifier {
  verify(input: VerifyInput): Promise<VerifyResult>;
}

/**
 * PayPal postback verification (POST /v1/notifications/verify-webhook-signature, Sandbox host only).
 * - The event is embedded byte-for-byte as received; re-serializing it can break verification.
 * - `cert_url` is passed to PayPal; OrderTruth never downloads a certificate from a request header.
 * - Bounded by `timeoutMs` end to end (OAuth token fetch included).
 */
export class PayPalPostbackVerifier implements WebhookVerifier {
  constructor(
    private readonly paypal: PayPalClient,
    private readonly timeoutMs: number,
  ) {}

  async verify(input: VerifyInput): Promise<VerifyResult> {
    const started = performance.now();
    const ms = () => Math.round(performance.now() - started);
    const h = input.headers;
    const prefix = JSON.stringify({
      auth_algo: h.authAlgo,
      cert_url: h.certUrl,
      transmission_id: h.transmissionId,
      transmission_sig: h.transmissionSig,
      transmission_time: h.transmissionTime,
      webhook_id: input.webhookId,
    });
    const postback = `${prefix.slice(0, -1)},"webhook_event":${input.rawBody}}`;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PayPalError("timeout", "webhook verification deadline", { httpStatus: null, debugId: null, issues: [], durationMs: ms() })), this.timeoutMs);
    });
    try {
      const r = await Promise.race([this.paypal.verifyWebhookSignature(postback, { correlationId: input.correlationId }, this.timeoutMs), deadline]);
      const s = r.body?.verification_status;
      if (s === "SUCCESS" || s === "FAILURE") return { status: s, durationMs: ms(), debugId: r.debugId };
      return { status: "UNAVAILABLE", kind: "malformed_response", durationMs: ms(), debugId: r.debugId };
    } catch (err) {
      if (err instanceof PayPalError) return { status: "UNAVAILABLE", kind: err.kind, durationMs: ms(), debugId: err.debugId };
      return { status: "UNAVAILABLE", kind: "local_error", durationMs: ms(), debugId: null };
    } finally {
      clearTimeout(timer);
    }
  }
}
