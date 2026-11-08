import type { PayPalClient } from "./paypal/client.ts";
import { PayPalError } from "./paypal/client.ts";
import { CheckoutError } from "./checkout-service.ts";
import { PostgresCheckoutStore, type ObservationProvenance } from "./db/postgres-checkout.ts";
import { GATE0_PRODUCT, type OrderReadback } from "./domain/checkout.ts";
import { toProviderValue } from "./domain/money.ts";
import { z } from "zod";

// Validate fields used by verification and evidence summaries. Additional PayPal
// fields are permitted here but never included in the reduced evidence summary.
const amountSchema = z.object({ currency_code: z.string().optional(),value: z.string().optional() }).passthrough();
const readbackSchema = z.object({ id: z.string(),status: z.string(),intent: z.string().optional(),
  links: z.array(z.object({ rel: z.string().optional() }).passthrough()).optional(),
  purchase_units: z.array(z.object({ reference_id: z.string().optional(),custom_id: z.string().optional(),amount: amountSchema.optional(),
    payee: z.object({ merchant_id: z.string().optional() }).passthrough().optional(),
    payments: z.object({ captures: z.array(z.object({ id: z.string().optional(),status: z.string().optional(),final_capture: z.boolean().optional(),amount: amountSchema.optional(),
      status_details: z.object({ reason: z.string().optional() }).passthrough().optional(),
    }).passthrough()).optional() }).passthrough().optional(),
  }).passthrough()).optional(),
}).passthrough();

type CheckoutProvider = Pick<PayPalClient, "createOrder" | "getOrder" | "captureOrder">;
const orderId = (id: string) => {
  if (!/^[A-Z0-9]{8,36}$/.test(id)) throw new CheckoutError("invalid_order_id", "Invalid order identifier", 400);
  return id;
};

/** Owner-only orchestration, to be mounted behind maintained session authentication.
 * No provider call runs in a DB transaction. Unknown capture outcomes use GET only;
 * a retry never releases or replaces a durable financial-operation claim. */
export class PostgresCheckoutService {
  constructor(private readonly provider: CheckoutProvider, private readonly store: PostgresCheckoutStore,
    private readonly provenance: ObservationProvenance = "PAYPAL_SANDBOX_GET") {
    if (provenance === "SYNTHETIC_QUALIFICATION" && process.env.NODE_ENV !== "test") throw new Error("Synthetic checkout provider is test-only");
  }
  async create(key: string) {
    const { intent, attempt } = await this.store.createCheckout(key);
    const amount = { currency: intent.currency, value: toProviderValue({ currency: intent.currency, minor: intent.amount_minor }) };
    if (attempt.paypal_order_id) return { intentId: intent.id, attemptId: attempt.id, orderId: attempt.paypal_order_id, state: attempt.state, amount, reused: true };
    // Durable request ID is reused even if a prior create response was lost.
    let response;
    try { response = await this.provider.createOrder({ intent: "CAPTURE", purchase_units: [{
      reference_id: GATE0_PRODUCT.sku, custom_id: intent.id, description: GATE0_PRODUCT.name,
      amount: { currency_code: amount.currency, value: amount.value },
    }] }, attempt.create_request_id, { correlationId: intent.correlation_id }); }
    catch (error) {
      if (error instanceof PayPalError) await this.store.recordProviderResult(attempt.id, "create_order", error, this.provenance);
      throw error;
    }
    await this.store.recordCreate(attempt.id, response, this.provenance);
    return { intentId: intent.id, attemptId: attempt.id, orderId: response.body.id, state: "awaiting_buyer_approval" as const, amount, reused: false };
  }
  async readback(id: string) {
    return (await this.readbackIf(id, "manual", () => null)).result;
  }
  async ownsOrder(id: string) {
    if (!/^[A-Z0-9]{8,36}$/.test(id)) return null;
    try { const { intent, attempt } = await this.store.byOrder(id); return { intentId: intent.id, attemptId: attempt.id }; }
    catch (error) { if (error instanceof Error && error.message === "Payment attempt not found") return null; throw error; }
  }
  async readbackIf(id: string, correlationId: string, accept: (raw: OrderReadback) => string | null) {
    const { intent, attempt } = await this.store.byOrder(orderId(id));
    let response;
    try {
      response = await this.provider.getOrder(id, { correlationId: intent.correlation_id });
      if (response.httpStatus !== 200 || !readbackSchema.safeParse(response.body).success) throw new PayPalError("network","Provider readback structure unavailable",{
        httpStatus: response.httpStatus,debugId: response.debugId,issues: [],durationMs: response.durationMs,
      });
    }
    catch (error) {
      if (error instanceof PayPalError) await this.store.recordProviderResult(attempt.id, "readback", error, this.provenance);
      throw error;
    }
    const raw = response.body as OrderReadback;
    const reason = accept(raw);
    const result = await this.store.recordReadback(attempt.id, raw, this.provenance, response, correlationId === "manual" ? undefined : { refusal: reason });
    return { applied: reason === null && result.accepted, reason: reason ?? (result.accepted ? null : "Conflicting accepted provider identity"), result: result.attempt };
  }
  async capture(id: string) {
    orderId(id);
    let observed;
    try { observed = await this.readback(id); }
    catch (error) {
      if (!(error instanceof PayPalError)) throw error;
      throw new CheckoutError("outcome_unknown", "PayPal readback is unavailable. Do not pay again; resume this checkout later.", 503);
    }
    if (observed.state !== "approved") return observed;
    if (!await this.store.claimCapture(observed.id, Date.now())) return (await this.store.byOrder(id)).attempt;
    // One durable claim across all processes. No automatic POST retry after an
    // uncertain side effect; authoritative GET can settle it after restart.
    try {
      const result = await this.provider.captureOrder(id, observed.capture_request_id, { correlationId: (await this.store.byOrder(id)).intent.correlation_id });
      await this.store.recordProviderResult(observed.id, "capture_order", result, this.provenance);
    } catch (error) {
      if (!(error instanceof PayPalError)) throw error;
      await this.store.recordProviderResult(observed.id, "capture_order", error, this.provenance);
    }
    try { return await this.readback(id); }
    catch (error) {
      if (!(error instanceof PayPalError)) throw error;
      throw new CheckoutError("outcome_unknown", "Capture outcome is unknown. Do not pay again; resume readback for this checkout.", 503);
    }
  }
}
