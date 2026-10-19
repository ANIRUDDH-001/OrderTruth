/**
 * Stage 1C review corrections (review of a36852d):
 *  - P1a the contract compares each merchant order to the captured payment, not merely the count;
 *  - P1b controlled causation is attributed only through the involved orders' own fault references.
 * PayPal is the in-memory fake (MOCKED). No PayPal call is made by the checker.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MIGRATIONS, Store } from "../src/db/store.ts";
import { buildIncidentApi, ORG_HEADER } from "../src/merchant/api.ts";
import { attributeCause, InvariantChecker } from "../src/merchant/checker.ts";
import { evaluateContract, orderMismatches, type OrderFact, type PaymentFacts } from "../src/merchant/contract.ts";
import { injectDuplicateOrderRace } from "../src/merchant/fault-injection.ts";
import { ReferenceMerchant } from "../src/merchant/reference-merchant.ts";
import { MerchantRepo, REFERENCE_ORG, type FaultInjectionRow, type MerchantOrderRow } from "../src/merchant/repo.ts";
import { captureEvent, deliver, ourOrder, setupWebhook, type Setup } from "./helpers/webhook-fixtures.ts";

const dir = mkdtempSync(join(tmpdir(), "ordertruth-s1c-fix-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const dbFile = () => join(dir, `fix-${++n}.sqlite`);
const ORG = REFERENCE_ORG;

// ---- pure contract ---------------------------------------------------------------------------

const P: PaymentFacts = {
  intentId: "ci_k",
  intentSku: "SKU-K",
  intentCurrency: "USD",
  intentMinor: 100,
  attemptId: "pa_k",
  attemptState: "captured",
  paypalOrderId: "ORDK",
  captureId: "CAPK",
  captureStatus: "COMPLETED",
  capturedMinor: 100,
  capturedCurrency: "USD",
  readbacks: [
    { seq: 7, httpStatus: 200, createdAt: "t", orderId: "ORDK", orderStatus: "COMPLETED", units: [{ customId: "ci_k", captures: [{ id: "CAPK", status: "COMPLETED", currency: "USD", value: "1.00" }] }] },
  ],
};
const good = (id: string, o: Partial<OrderFact> = {}): OrderFact => ({ id, status: "placed", attemptId: "pa_k", paypalOrderId: "ORDK", captureId: "CAPK", sku: "SKU-K", amountMinor: 100, currency: "USD", ...o });

const MISMATCHES: Array<[string, Partial<OrderFact>, RegExp]> = [
  ["capture id", { captureId: "CAP-OTHER" }, /capture id/],
  ["amount", { amountMinor: 99 }, /amount/],
  ["currency", { currency: "EUR" }, /currency/],
  ["PayPal order id", { paypalOrderId: "ORD-OTHER" }, /PayPal order id/],
  ["SKU", { sku: "SKU-OTHER" }, /sku/i],
  ["payment attempt", { attemptId: "pa_other" }, /attempt/],
];

describe("P1a contract compares merchant-order correctness, not merely count", () => {
  it("K0 controls: one matching order HOLDS, two matching orders VIOLATE", () => {
    expect(evaluateContract(P, [good("mo_1")]).result).toBe("HOLDS");
    expect(evaluateContract(P, [good("mo_1"), good("mo_2")]).result).toBe("VIOLATED");
  });

  for (const [what, patch, re] of MISMATCHES) {
    it(`K1 a single placed order with the wrong ${what} cannot HOLD -> OUT_OF_SCOPE with an explicit reason`, () => {
      const e = evaluateContract(P, [good("mo_bad", patch)]);
      expect(e.result).toBe("OUT_OF_SCOPE");
      expect(e.reasons.join(" ")).toMatch(re);
      expect(e.reasons.join(" ")).toMatch(/mo_bad/);
      expect(e.matchingOrderIds).toEqual([]);
    });
  }

  it("K2 orderMismatches names every differing field explicitly", () => {
    expect(orderMismatches(good("mo_1"), P)).toEqual([]);
    const all = orderMismatches(good("mo_x", { attemptId: "a", paypalOrderId: "b", captureId: "c", sku: "d", amountMinor: 1, currency: "EUR" }), P);
    expect(all).toHaveLength(6);
  });

  it("K3 one matching order plus one mismatched order is neither HOLDS nor VIOLATED", () => {
    const e = evaluateContract(P, [good("mo_1"), good("mo_bad", { amountMinor: 5000 })]);
    expect(e.result).toBe("OUT_OF_SCOPE");
    expect(e.matchingOrderIds).toEqual(["mo_1"]);
    expect(e.reasons.join(" ")).toMatch(/do not match the captured payment/);
    expect(e.reasons.join(" ")).toMatch(/mo_bad.*amount minor 5000 != 100/);
    expect(e.reasons.join(" ")).not.toMatch(/no merchant order yet/);
  });

  it("K4 a duplicate of matching orders stays VIOLATED even if an extra mismatched order exists; the mismatch is reported", () => {
    const e = evaluateContract(P, [good("mo_1"), good("mo_2"), good("mo_bad", { captureId: "X" })]);
    expect(e.result).toBe("VIOLATED");
    expect(e.matchingOrderIds).toEqual(["mo_1", "mo_2"]);
    expect(e.reasons.join(" ")).toMatch(/mo_bad.*capture id/);
  });

  it("K5 non-placed orders are ignored for both count and correctness", () => {
    expect(evaluateContract(P, [good("mo_1"), good("mo_old", { status: "cancelled", captureId: "X" })]).result).toBe("HOLDS");
  });
});

// ---- checker + database ----------------------------------------------------------------------

async function captured(s: Setup) {
  const o = await ourOrder(s);
  s.fake.approve(o.orderId);
  expect((await s.checkout.capture(o.orderId, "corr-fix")).state).toBe("captured");
  expect((await deliver(s, captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: o.intentId }))).status).toBe(200);
  await s.svc.processor.drain();
  return o;
}

const insertOrder = (s: Setup, o: Awaited<ReturnType<typeof captured>>, patch: Record<string, string | number> = {}) => {
  const intent = s.store.db.prepare("SELECT sku, currency, amount_minor FROM checkout_intents WHERE id = ?").get(o.intentId) as { sku: string; currency: string; amount_minor: number };
  const row = { id: `mo_${++n}`, attempt_id: o.attemptId, paypal_order_id: o.orderId, capture_id: o.captureId, sku: intent.sku, currency: intent.currency, amount_minor: intent.amount_minor, ...patch };
  s.store.db
    .prepare(
      `INSERT INTO merchant_orders (id, organization_id, intent_id, attempt_id, paypal_order_id, capture_id, sku, currency, amount_minor, status, created_by_path, fault_injection_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'placed', 'capture_return', NULL, ?)`,
    )
    .run(row.id, ORG, o.intentId, row.attempt_id, row.paypal_order_id, row.capture_id, row.sku, row.currency, row.amount_minor, new Date().toISOString());
  return row.id;
};

const DB_MISMATCHES: Array<[string, Record<string, string | number>]> = [
  ["capture id", { capture_id: "CAP-OTHER" }],
  ["amount", { amount_minor: 99 }],
  ["currency", { currency: "EUR" }],
  ["PayPal order id", { paypal_order_id: "ORD-OTHER" }],
  ["SKU", { sku: "SKU-OTHER" }],
];

describe("P1a checker and database agree with the contract", () => {
  it("K6 checker: a pre-existing single order with the wrong capture id (row predating the stricter trigger) -> OUT_OF_SCOPE, no incident", async () => {
    const s = await setupWebhook({ path: dbFile() });
    const o = await captured(s);
    s.store.db.exec("DROP TRIGGER merchant_orders_i"); // disposable test DB: simulate a row written before migration 5
    const bad = insertOrder(s, o, { capture_id: "CAP-NOT-THE-CAPTURE" });
    const c = new InvariantChecker(s.store).evaluateIntent(ORG, o.intentId);
    expect(c.result).toBe("OUT_OF_SCOPE");
    expect(c.reasons.join(" ")).toMatch(new RegExp(`${bad}.*capture id`));
    expect(new MerchantRepo(s.store).listIncidents(ORG)).toHaveLength(0);
    s.store.close();
  });

  for (const [what, patch] of DB_MISMATCHES) {
    it(`K7 database refuses a merchant order whose ${what} differs from the captured payment`, async () => {
      const s = await setupWebhook({ path: dbFile() });
      const o = await captured(s);
      expect(() => insertOrder(s, o, patch)).toThrow(/merchant order must/);
      s.store.close();
    });
  }

  it("K8 database refuses an order for an intent whose payment is not captured", async () => {
    const s = await setupWebhook({ path: dbFile() });
    const o = await ourOrder(s);
    expect(() => insertOrder(s, { ...o }, { capture_id: o.captureId })).toThrow(/merchant order must/);
    s.store.close();
  });

  it("K8b database refuses an order for a PENDING capture even when the capture id matches", async () => {
    const s = await setupWebhook({ path: dbFile() });
    const o = await ourOrder(s);
    expect(s.store.transition(o.attemptId, "pending", { capture_id: o.captureId, capture_status: "PENDING" })).toBe(true);
    expect(() => insertOrder(s, { ...o })).toThrow(/merchant order must/);
    s.store.close();
  });

  it("K9 the deliberate REF-BUG-1 duplicate stays reproducible: two correct orders for one intent are accepted by the database", async () => {
    const s = await setupWebhook({ path: dbFile() });
    const o = await captured(s);
    insertOrder(s, o);
    insertOrder(s, o);
    expect(new InvariantChecker(s.store).evaluateIntent(ORG, o.intentId).result).toBe("VIOLATED");
    s.store.close();
  });
});

describe("migration 5 is additive", () => {
  it("K10 a v4 database holding a mismatched order migrates to v5 with the row untouched; only new inserts are refused", () => {
    const path = dbFile();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (let v = 0; v < 4; v++) {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations VALUES (?, 'x')").run(v + 1);
    }
    db.prepare("INSERT INTO checkout_intents (id, sku, currency, amount_minor, correlation_id, created_at, checkout_key) VALUES ('ci_k10', 'S', 'USD', 100, 'c', 't', 'ck_k10k10k10k10k10k10')").run();
    db.prepare("INSERT INTO payment_attempts (id, intent_id, create_request_id, capture_request_id, state, created_at, updated_at) VALUES ('pa_k10', 'ci_k10', 'a', 'b', 'created', 't', 't')").run();
    const ins = (id: string) =>
      db.prepare(`INSERT INTO merchant_orders (id, organization_id, intent_id, attempt_id, paypal_order_id, capture_id, sku, currency, amount_minor, status, created_by_path, fault_injection_id, created_at)
                  VALUES (?, 'org_reference', 'ci_k10', 'pa_k10', 'ORD', 'CAP', 'S', 'USD', 999, 'placed', 'capture_return', NULL, 't')`).run(id);
    ins("mo_legacy"); // v4 trigger allowed a mismatched, uncaptured order
    const before = JSON.stringify(db.prepare("SELECT * FROM merchant_orders").all());
    db.close();
    const store = new Store(path);
    expect((store.db.prepare("SELECT MAX(version) v FROM schema_migrations").get() as { v: number }).v).toBe(5);
    expect(JSON.stringify(store.db.prepare("SELECT * FROM merchant_orders").all())).toBe(before);
    expect(() => store.db.prepare(`INSERT INTO merchant_orders (id, organization_id, intent_id, attempt_id, paypal_order_id, capture_id, sku, currency, amount_minor, status, created_by_path, fault_injection_id, created_at)
                  VALUES ('mo_new', 'org_reference', 'ci_k10', 'pa_k10', 'ORD', 'CAP', 'S', 'USD', 999, 'placed', 'capture_return', NULL, 't')`).run()).toThrow(/merchant order must/);
    store.close();
  });
});

// ---- causal provenance -----------------------------------------------------------------------

/** A fault record is written before execution, then the injection fails before placing any order. */
async function failedInjection(s: Setup, intentId: string) {
  const merchant = new ReferenceMerchant(s.store);
  const spy = vi.spyOn(merchant, "placeOrderForCapturedIntent").mockRejectedValue(new Error("simulated injection failure"));
  await expect(injectDuplicateOrderRace(merchant, ORG, intentId)).rejects.toThrow(/simulated injection failure/);
  spy.mockRestore();
  const faults = new MerchantRepo(s.store).faultsForIntent(ORG, intentId);
  expect(faults).toHaveLength(1);
  expect(new MerchantRepo(s.store).ordersForIntent(ORG, intentId)).toHaveLength(0);
  return { merchant, faultId: faults[0]!.id };
}

describe("P1b controlled causation only through the involved orders' fault references", () => {
  it("V0 attributeCause ignores an order fault reference that names no recorded fault for the intent", () => {
    const order = (id: string, fault: string | null) => ({ id, created_by_path: "capture_return", fault_injection_id: fault }) as MerchantOrderRow;
    const fault = { id: "fi_real", kind: "DUPLICATE_ORDER_RACE" } as FaultInjectionRow;
    expect(attributeCause([order("mo_1", "fi_dangling"), order("mo_2", "fi_dangling")], [fault])).toMatchObject({ cause: "UNKNOWN", faultInjectionIds: [] });
    expect(attributeCause([order("mo_1", "fi_real"), order("mo_2", "fi_real")], [fault])).toMatchObject({ cause: "CONTROLLED_FAULT_INJECTION", faultInjectionIds: ["fi_real"], unreferencedFaultRecords: [] });
  });

  it("V1 failed injection followed by an organic duplicate is NOT labelled a controlled cause; the fault record is preserved, not overstated", async () => {
    const s = await setupWebhook({ path: dbFile() });
    const o = await captured(s);
    const { merchant, faultId } = await failedInjection(s, o.intentId);
    await Promise.all([merchant.placeOrderForCapturedIntent(ORG, o.intentId, "capture_return"), merchant.placeOrderForCapturedIntent(ORG, o.intentId, "webhook_capture_completed")]);

    const c = new InvariantChecker(s.store).evaluateIntent(ORG, o.intentId);
    expect(c.result).toBe("VIOLATED");
    const repo = new MerchantRepo(s.store);
    const rep = JSON.parse(repo.getIncident(ORG, c.incidentId!)!.reproduction_json);
    expect(rep.cause).toBe("UNKNOWN");
    expect(rep.faultInjectionIds ?? []).toEqual([]);
    expect(rep.unreferencedFaultRecords).toEqual([{ id: faultId, kind: "DUPLICATE_ORDER_RACE", causalStatus: "NOT_REFERENCED_BY_ANY_INVOLVED_ORDER" }]);
    expect(rep.orders.every((x: { faultInjectionId: string | null }) => x.faultInjectionId === null)).toBe(true);
    // The historical record survives, but is not filed as evidence of the cause.
    expect(repo.faultsForIntent(ORG, o.intentId).map((f) => f.id)).toEqual([faultId]);
    expect(repo.incidentEvidence(c.incidentId!).filter((e) => e.evidence_class === "CONTROLLED_FAULT_INJECTION")).toEqual([]);
    const app = await buildIncidentApi({ store: s.store });
    const d = (await app.inject({ url: `/api/incidents/${c.incidentId}`, headers: { [ORG_HEADER]: ORG } })).json();
    expect(d.reproduction.cause).toBe("UNKNOWN");
    expect(d.affectedOrders.map((x: { provenance: string }) => x.provenance)).toEqual(["REFERENCE_MERCHANT_FLOW", "REFERENCE_MERCHANT_FLOW"]);
    await app.close();
    s.store.close();
  });

  it("V2 one order carrying the fault reference and one organic order -> MIXED, only the referenced fault linked", async () => {
    const s = await setupWebhook({ path: dbFile() });
    const o = await captured(s);
    const { merchant, faultId } = await failedInjection(s, o.intentId);
    await Promise.all([
      merchant.placeOrderForCapturedIntent(ORG, o.intentId, "capture_return", { faultInjectionId: faultId }),
      merchant.placeOrderForCapturedIntent(ORG, o.intentId, "webhook_capture_completed"),
    ]);
    const c = new InvariantChecker(s.store).evaluateIntent(ORG, o.intentId);
    expect(c.result).toBe("VIOLATED");
    const repo = new MerchantRepo(s.store);
    const rep = JSON.parse(repo.getIncident(ORG, c.incidentId!)!.reproduction_json);
    expect(rep.cause).toBe("MIXED");
    expect(rep.faultInjectionIds).toEqual([faultId]);
    expect(rep.unreferencedFaultRecords).toEqual([]);
    expect(repo.incidentEvidence(c.incidentId!).filter((e) => e.evidence_class === "CONTROLLED_FAULT_INJECTION").map((e) => e.ref_id)).toEqual([faultId]);
    s.store.close();
  });

  it("V3 the successful controlled injection is still CONTROLLED_FAULT_INJECTION, with every involved order referencing it", async () => {
    const s = await setupWebhook({ path: dbFile() });
    const o = await captured(s);
    const { faultInjectionId } = await injectDuplicateOrderRace(new ReferenceMerchant(s.store), ORG, o.intentId);
    const c = new InvariantChecker(s.store).evaluateIntent(ORG, o.intentId);
    const rep = JSON.parse(new MerchantRepo(s.store).getIncident(ORG, c.incidentId!)!.reproduction_json);
    expect(rep.cause).toBe("CONTROLLED_FAULT_INJECTION");
    expect(rep.faultInjectionIds).toEqual([faultInjectionId]);
    expect(rep.unreferencedFaultRecords).toEqual([]);
    s.store.close();
  });
});
