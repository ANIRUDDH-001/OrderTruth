import { randomUUID } from "node:crypto";
import type { ReferenceMerchant } from "./reference-merchant.ts";

export const FAULT_LABEL = "CONTROLLED_FAULT_INJECTION";

export class FaultInjectionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaultInjectionRefused";
  }
}

/** Resolves every waiter once `parties` have arrived. */
function barrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((r) => (release = r));
  return () => {
    if (++arrived === parties) release();
    return all;
  };
}

/**
 * CONTROLLED_FAULT_INJECTION: deterministically exercises REF-BUG-1. The capture-return path and the
 * webhook path both run; a two-party barrier holds each after its "already ordered?" check until
 * both checks have completed, so both insert. The injection is recorded durably BEFORE it runs and
 * every order it causes carries its id, so the duplicate can never pass as organic behaviour.
 * Local merchant data only: no PayPal call, no payment state change.
 */
export async function injectDuplicateOrderRace(merchant: ReferenceMerchant, orgId: string, intentId: string) {
  const repo = merchant.repo;
  if (!repo.intentInOrg(orgId, intentId)) throw new FaultInjectionRefused("intent not found for this organization");
  // Both paths must reach the barrier; a path that throws before it would leave the other waiting.
  if (merchant.store.getAttemptByIntentId(intentId)?.state !== "captured") throw new FaultInjectionRefused("payment for this intent is not captured");
  if (repo.ordersForIntent(orgId, intentId).length > 0) throw new FaultInjectionRefused("intent already has merchant orders; fault requires a fresh intent");
  const id = `fi_${randomUUID()}`;
  const params = {
    bug: "REF-BUG-1 check-then-insert without unique key",
    paths: ["capture_return", "webhook_capture_completed"],
    interleaving: "both existence checks complete before either insert (2-party barrier)",
    expectedOrders: 2,
  };
  merchant.store.db
    .prepare("INSERT INTO fault_injections (id, organization_id, label, kind, intent_id, params_json, created_at) VALUES (?, ?, ?, 'DUPLICATE_ORDER_RACE', ?, ?, ?)")
    .run(id, orgId, FAULT_LABEL, intentId, JSON.stringify(params), new Date().toISOString());
  const arrive = barrier(2);
  const hooks = { afterCheck: arrive, faultInjectionId: id };
  const results = await Promise.all([
    merchant.placeOrderForCapturedIntent(orgId, intentId, "capture_return", hooks),
    merchant.placeOrderForCapturedIntent(orgId, intentId, "webhook_capture_completed", hooks),
  ]);
  return { faultInjectionId: id, results };
}
