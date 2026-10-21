import type { PayPalClient } from "./paypal/client.ts";
import { PayPalError } from "./paypal/client.ts";
import { CheckoutError } from "./checkout-service.ts";
import { PostgresCheckoutStore, type ObservationProvenance } from "./db/postgres-checkout.ts";
import { GATE0_PRODUCT, type OrderReadback } from "./domain/checkout.ts";
import { toProviderValue } from "./domain/money.ts";

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
    try { response = await this.provider.getOrder(id, { correlationId: intent.correlation_id }); }
    catch (error) {
      if (error instanceof PayPalError) await this.store.recordProviderResult(attempt.id, "readback", error, this.provenance);
      throw error;
    }
    if (!response.body || typeof response.body !== "object") throw new CheckoutError("provider_mismatch", "Provider readback was not an order", 502);
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
