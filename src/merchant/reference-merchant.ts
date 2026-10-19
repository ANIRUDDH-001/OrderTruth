import { randomUUID } from "node:crypto";
import type { Store } from "../db/store.ts";
import { MerchantRepo, type MerchantOrderRow } from "./repo.ts";

export type OrderPath = MerchantOrderRow["created_by_path"];

export class MerchantError extends Error {
  constructor(
    readonly code: "unknown_intent" | "payment_not_captured",
    message: string,
  ) {
    super(message);
    this.name = "MerchantError";
  }
}

/** Test/demo-only hooks. Only the controlled fault injector passes them. */
export type PlaceOrderHooks = { afterCheck?: () => Promise<void>; faultInjectionId?: string };

/**
 * The first REFERENCE MERCHANT: places one local order when a payment for an intent is captured.
 * Two paths call it, as in a typical shop: the buyer's capture return and the
 * PAYMENT.CAPTURE.COMPLETED webhook. It trusts the local attempt state, which only an
 * authoritative PayPal readback can set to `captured`.
 *
 * REF-BUG-1 (deliberate, documented): "already ordered?" is a read, then an await, then an insert,
 * with no unique key on intent_id. Sequential calls are idempotent; two calls whose checks both
 * finish before either insert create two orders. OrderTruth must DETECT this, not hide it.
 * The merchant never touches PayPal.
 */
export class ReferenceMerchant {
  readonly repo: MerchantRepo;

  constructor(readonly store: Store) {
    this.repo = new MerchantRepo(store);
  }

  async placeOrderForCapturedIntent(orgId: string, intentId: string, path: OrderPath, hooks: PlaceOrderHooks = {}): Promise<{ order: MerchantOrderRow; created: boolean }> {
    const intent = this.repo.intentInOrg(orgId, intentId);
    if (!intent) throw new MerchantError("unknown_intent", "intent not found for this organization");
    const attempt = this.store.getAttemptByIntentId(intentId);
    if (!attempt || attempt.state !== "captured" || !attempt.capture_id || !attempt.paypal_order_id) {
      throw new MerchantError("payment_not_captured", `payment state ${attempt?.state ?? "missing"}; no order placed`);
    }
    const existing = this.repo.ordersForIntent(orgId, intentId)[0];
    if (existing) return { order: existing, created: false };

    await hooks.afterCheck?.(); // REF-BUG-1 window (real shops: an inventory/email/API call here)

    const order: MerchantOrderRow = {
      id: `mo_${randomUUID()}`,
      organization_id: orgId,
      intent_id: intentId,
      attempt_id: attempt.id,
      paypal_order_id: attempt.paypal_order_id,
      capture_id: attempt.capture_id,
      sku: intent.sku,
      currency: intent.currency,
      amount_minor: intent.amount_minor,
      status: "placed",
      created_by_path: path,
      fault_injection_id: hooks.faultInjectionId ?? null,
      created_at: new Date().toISOString(),
    };
    this.store.db
      .prepare(
        `INSERT INTO merchant_orders (id, organization_id, intent_id, attempt_id, paypal_order_id, capture_id, sku, currency, amount_minor, status, created_by_path, fault_injection_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(order.id, order.organization_id, order.intent_id, order.attempt_id, order.paypal_order_id, order.capture_id, order.sku, order.currency, order.amount_minor, order.status, order.created_by_path, order.fault_injection_id, order.created_at);
    return { order, created: true };
  }

  /** HEALTHY reference run: both paths fire (as when the webhook follows the capture return), in sequence. */
  async healthyBothPaths(orgId: string, intentId: string) {
    const a = await this.placeOrderForCapturedIntent(orgId, intentId, "capture_return");
    const b = await this.placeOrderForCapturedIntent(orgId, intentId, "webhook_capture_completed");
    return [a, b];
  }
}
