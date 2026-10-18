import { maskId } from "../redact.ts";
import type { OrderReadback } from "../domain/checkout.ts";

/**
 * Allowlist summaries of PayPal responses for evidence. Only fields needed to verify the
 * payment outcome are kept; payer identity, addresses, emails and links are never stored.
 */
export function summarizeOrder(raw: unknown) {
  const o = (raw ?? {}) as OrderReadback & { create_time?: string; update_time?: string; links?: Array<{ rel?: string }> };
  return {
    id: o.id ?? null,
    status: o.status ?? null,
    intent: o.intent ?? null,
    create_time: o.create_time ?? null,
    update_time: o.update_time ?? null,
    link_rels: (o.links ?? []).map((l) => l.rel ?? "?"),
    purchase_units: (o.purchase_units ?? []).map((u) => ({
      reference_id: u.reference_id ?? null,
      custom_id: u.custom_id ?? null,
      amount: u.amount ? { currency_code: u.amount.currency_code ?? null, value: u.amount.value ?? null } : null,
      payee_merchant_id_masked: maskId(u.payee?.merchant_id),
      captures: (u.payments?.captures ?? []).map((c) => ({
        id: c.id ?? null,
        status: c.status ?? null,
        final_capture: c.final_capture ?? null,
        amount: c.amount ? { currency_code: c.amount.currency_code ?? null, value: c.amount.value ?? null } : null,
        status_reason: c.status_details?.reason ?? null,
      })),
    })),
  };
}
