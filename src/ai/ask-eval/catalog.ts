/**
 * Frozen evidence for the Ask OrderTruth evaluation (docs/ASK_EVAL_PROTOCOL.md).
 * One case in two states: PRE (duplicate detected, diagnostics run, plan awaiting approval) and
 * POST (approved repair executed and verified). Values are a SYNTHETIC fixture modelled on the
 * hosted judge run of 2026-10-29 (run_a9ef2c36…); the PayPal order and capture IDs are invented.
 * `source` names the product record each fact comes from, so availability per state can be checked.
 * Both arms see exactly this catalog and nothing else about the case.
 */
export type SnapshotId = "PRE" | "POST";
/** `tokens` are the machine-checkable values a fact states verbatim (IDs, amounts, durations, clock times, counts). */
export type Fact = { id: string; evidenceId: string; text: string; tokens: readonly string[]; source: string };

const PAYPAL_ORDER = "8XK70219HM5537412",CAPTURE = "2HB58430TR8019935",RUN = "M_run_a9ef2c36-1eb1-492b-9662-5eb656cca492";
const ORDER_A = "mo_5fc89787-f051-4521-901a-aa4c4ac54ac2",ORDER_B = "mo_1d9841c0-2f9b-494e-affd-3e3355364997";
const TIMING = "D_d1e84a0b-e2b1-4956-a870-74ab5e2970e6",KEYS = "D_6c0f2a91-3b7e-4d55-9a1c-58e2f4b7d013",WRITES = "D_93ab47e2-0c6d-4f18-b2a5-7d1e9c60f4a8";
const PLAN = "rp_bd08d6d7-9757-4b22-95dd-e1525a83dcfc",PLAN_HASH = "0a4e7157af17b0efbee33d188627dccd0233dea2b116b6df6766256ca4962169";
const PROVIDER_HASH_PREFIX = "7c1e5f0b92d4";

const shared: Fact[] = [
  { id: "PAY_STATUS",evidenceId: "E5",text: `PayPal order ${PAYPAL_ORDER} is COMPLETED (PayPal Sandbox observation E5, read 2026-10-21 14:14:17 UTC).`,tokens: [PAYPAL_ORDER,"COMPLETED","E5","2026-10-21","14:14:17"],
    source: "evidence (PAYPAL_API_READBACK, GET) summary_json.id, summary_json.status, evidence.created_at" },
  { id: "PAY_CAPTURE_COUNT",evidenceId: "E5",text: "PayPal recorded exactly one capture for this payment.",tokens: ["one"],
    source: "evidence (PAYPAL_API_READBACK) summary_json.purchase_units[].captures[] count" },
  { id: "PAY_CAPTURE",evidenceId: "E5",text: `Capture ${CAPTURE} is COMPLETED for USD 1.00.`,tokens: [CAPTURE,"COMPLETED","USD 1.00","1.00"],
    source: "evidence (PAYPAL_API_READBACK) summary_json.purchase_units[].captures[].id/status/amount" },
  { id: "PAY_SOURCE",evidenceId: "E5",text: "The payment record is a PayPal Sandbox observation read back with a GET request; this case never creates, copies or changes a payment.",tokens: ["Sandbox"],
    source: "scenario_runs.provenance = PAYPAL_SANDBOX_GET; scenario_runs.source_evidence_seq" },
  { id: "INCIDENT",evidenceId: RUN,text: "OrderTruth's check found a violation: one completed capture had 2 active merchant orders instead of exactly 1 (detected 2026-10-29 06:12:00 UTC).",tokens: ["2","1","2026-10-29","06:12:00"],
    source: "incidents (state, created_at) via scenario_run_incidents; invariant_evaluations result VIOLATED" },
  { id: "TIMING",evidenceId: TIMING,text: `Handler timing (${TIMING}): the two recorded writes did not overlap; the second started 16.6 s after the first finished. They took 33 ms and 16 ms.`,tokens: [TIMING,"16.6 s","33 ms","16 ms"],
    source: "scenario_diagnostics kind HANDLER_TIMING facts_json.entries[] (startedAt, finishedAt, durationMs)" },
  { id: "TIMING_NOTE",evidenceId: TIMING,text: "In this controlled case the second write runs when \"Introduce duplicate\" is pressed, so the gap is not webhook delivery latency. Timing alone does not establish PayPal concurrency.",tokens: [],
    source: "scenario_diagnostics HANDLER_TIMING facts_json.note; scenario_runs.label CONTROLLED_MERCHANT_SCENARIO" },
  { id: "KEYS",evidenceId: KEYS,text: `Idempotency keys (${KEYS}): the two writes used 2 distinct deduplication keys, one per handler (capture_return, webhook_capture_completed).`,tokens: [KEYS,"2","capture_return","webhook_capture_completed"],
    source: "scenario_diagnostics kind IDEMPOTENCY_KEYS facts_json.distinctKeys, entries[].handler" },
  { id: "WRITES",evidenceId: WRITES,text: `Write outcomes (${WRITES}): 2 committed merchant writes were recorded. A missing row would not prove that no failed attempt happened.`,tokens: [WRITES,"2"],
    source: "scenario_diagnostics kind MERCHANT_WRITE_OUTCOMES facts_json.committedWrites, limitation" },
  { id: "PLAN",evidenceId: PLAN,text: `Repair plan ${PLAN} (hash ${PLAN_HASH}): keep ${ORDER_A}, void ${ORDER_B} on the merchant side only. Approval window ends 2026-10-29 06:27:49 UTC.`,tokens: [PLAN,PLAN_HASH,ORDER_A,ORDER_B,"2026-10-29","06:27:49"],
    source: "repair_plans (id, plan_sha256, keep_order_id, void_order_ids_json, expires_at) via scenario_run_plans" },
  { id: "POLICY",evidenceId: "POLICY",text: "By design, OrderTruth never captures, refunds or changes PayPal payments, and never contacts customers. Its only repair is a merchant-side void of a duplicate order, after explicit approval of the exact plan.",tokens: [],
    source: "documented system behaviour, not a case record or payment-event evidence: the judge API has no refund, capture or contact route, and its only repair action is a merchant-side void (src/merchant/postgres-recovery.ts)" },
];
const orderA: Fact = { id: "ORD_A",evidenceId: RUN,text: `Order ${ORDER_A} (USD 1.00) was written by the capture_return handler at 2026-10-29 06:11:34.511 UTC. Status: active.`,
  tokens: [ORDER_A,"USD 1.00","1.00","capture_return","2026-10-29","06:11:34.511","06:11:34"],source: "merchant_orders (id, amount_minor, currency, created_by_path, created_at) via scenario_run_orders" };
const orderB = (status: string,source: string): Fact => ({ id: "ORD_B",evidenceId: RUN,text: `Order ${ORDER_B} (USD 1.00) was written by the webhook_capture_completed handler at 2026-10-29 06:11:51.141 UTC. Status: ${status}.`,
  tokens: [ORDER_B,"USD 1.00","1.00","webhook_capture_completed","2026-10-29","06:11:51.141","06:11:51"],source });

export const SNAPSHOTS: Record<SnapshotId,readonly Fact[]> = {
  PRE: [...shared,orderA,orderB("active","merchant_orders (id, amount_minor, currency, created_by_path, created_at) via scenario_run_orders; no void row"),
    { id: "ORD_COUNT",evidenceId: RUN,text: "2 merchant orders reference this one payment; 2 are active.",tokens: ["2"],source: "scenario_run_orders ⋈ merchant_orders, effective status (no voids yet)" },
    { id: "APPROVAL",evidenceId: PLAN,text: "The repair plan has not been approved, and nothing has been changed yet.",tokens: [],source: "repair_approvals: no row for this plan" }],
  POST: [...shared,orderA,orderB("voided as a duplicate (merchant-side)","merchant_orders via scenario_run_orders; merchant_order_voids (reason DUPLICATE_MERCHANT_ORDER)"),
    { id: "ORD_COUNT",evidenceId: RUN,text: "2 merchant orders reference this one payment; 1 is active.",tokens: ["2","1"],source: "scenario_run_orders ⋈ merchant_orders, effective status after merchant_order_voids" },
    { id: "APPROVAL",evidenceId: PLAN,text: "The exact repair plan was approved in this judge session at 2026-10-29 06:13:20 UTC.",tokens: ["2026-10-29","06:13:20"],source: "repair_approvals (plan_sha256, approval_mode BROWSER_SESSION, approved_at)" },
    { id: "RECEIPT",evidenceId: PLAN,text: `Repair receipt: outcome SUCCEEDED at 2026-10-29 06:13:25 UTC. 1 active order remains, and it is the planned keeper ${ORDER_A}.`,tokens: ["SUCCEEDED","2026-10-29","06:13:25","1",ORDER_A],
      source: "repair_outcomes (outcome, completed_at); receipt verification (current activeOrders, matchingKeeper); incident_resolutions" },
    { id: "PAYPAL_UNCHANGED",evidenceId: PLAN,text: `The repair did not change the PayPal payment evidence: its SHA-256 before and after is identical (${PROVIDER_HASH_PREFIX}…).`,tokens: [PROVIDER_HASH_PREFIX],
      source: "repair_outcomes provider_before_sha256 = provider_after_sha256" }],
};
export const factIds = (snapshot: SnapshotId) => new Set(SNAPSHOTS[snapshot].map(f => f.id));
export const factById = (snapshot: SnapshotId,id: string) => SNAPSHOTS[snapshot].find(f => f.id === id);
