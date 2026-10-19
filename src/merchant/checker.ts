import { randomUUID } from "node:crypto";
import type { Store } from "../db/store.ts";
import { CONTRACT_ID, DUPLICATE_SEVERITY, evaluateContract, INCIDENT_CLASS, readbackFact, type EvaluationResult, type PaymentFacts } from "./contract.ts";
import { MerchantRepo, type FaultInjectionRow, type IncidentEvidenceRow, type MerchantOrderRow } from "./repo.ts";
import { assessMissingOrder, DEFAULT_MISSING_ORDER_GRACE_MS, MISSING_INCIDENT_CLASS } from "./missing-order.ts";

export type IntentCheck = { intentId: string; evaluationSeq: number; result: EvaluationResult; activeOrderCount: number; reasons: string[]; incidentId: string | null; incidentOpened: boolean; evidenceLinked: number };

type Link = { cls: IncidentEvidenceRow["evidence_class"]; refType: string; refId: string; sourceAt: string | null; summary: unknown };

/**
 * Deterministic invariant checker. Reads only local records: the authoritative PayPal evidence the
 * payment flow already persisted (PAYPAL_API_READBACK rows, PayPal-verified webhook events) and the
 * merchant's own orders. It never calls PayPal and never changes payment or merchant state.
 * Each evaluation is recorded; only VIOLATED opens an incident, at most one per intent (dedup key),
 * and re-running only appends evidence not linked yet. One transaction per intent.
 */
const MECHANISM = "REF-BUG-1: reference merchant check-then-insert without unique key; capture_return and webhook_capture_completed paths both pass the existence check before either inserts";

/**
 * Causal provenance of a duplicate, from the INVOLVED orders' own fault references only. A fault
 * record that no involved order references (e.g. an injection that failed before placing anything)
 * is preserved in the reproduction as history but is never treated as the cause.
 *   all involved orders reference a recorded fault -> CONTROLLED_FAULT_INJECTION
 *   none do -> UNKNOWN;  some do -> MIXED
 */
export function attributeCause(involved: readonly MerchantOrderRow[], faults: readonly FaultInjectionRow[]) {
  const known = new Set(faults.map((f) => f.id));
  const refs = involved.map((o) => (o.fault_injection_id && known.has(o.fault_injection_id) ? o.fault_injection_id : null));
  const faultInjectionIds = [...new Set(refs.filter((r): r is string => r !== null))];
  const referencing = refs.filter((r) => r !== null).length;
  const cause = referencing === 0 ? "UNKNOWN" : referencing === involved.length ? "CONTROLLED_FAULT_INJECTION" : "MIXED";
  return {
    cause,
    faultInjectionIds,
    orders: involved.map((o, i) => ({ id: o.id, createdByPath: o.created_by_path, faultInjectionId: refs[i] })),
    unreferencedFaultRecords: faults
      .filter((f) => !faultInjectionIds.includes(f.id))
      .map((f) => ({ id: f.id, kind: f.kind, causalStatus: "NOT_REFERENCED_BY_ANY_INVOLVED_ORDER" })),
    ...(cause === "UNKNOWN"
      ? { note: "no involved order references a controlled fault; duplicate observed in merchant data" }
      : {
          ...(faultInjectionIds.length === 1 ? { mechanism: MECHANISM } : { note: "involved orders reference different controlled injections; no single injection is established as the duplicate's cause" }),
          reproduce: "pnpm stage1c --mode fault --target-order <PayPal order id> (isolated DB copy) or pnpm exec vitest run tests/stage1c-merchant-incident.test.ts",
          ...(cause === "MIXED" ? { note: "only some involved orders reference a controlled fault; the rest are of unknown cause" } : {}),
        }),
  };
}

export class InvariantChecker {
  readonly repo: MerchantRepo;

  constructor(readonly store: Store, private readonly options: { now?: () => number; missingOrderGraceMs?: number } = {}) {
    const grace = options.missingOrderGraceMs ?? DEFAULT_MISSING_ORDER_GRACE_MS;
    if (!Number.isSafeInteger(grace) || grace < 0) throw new Error("missing order grace must be a nonnegative safe integer in milliseconds");
    this.repo = new MerchantRepo(store);
  }

  #paymentFacts(intent: { id: string; sku: string; currency: string; amount_minor: number }): PaymentFacts {
    const a = this.store.getAttemptByIntentId(intent.id);
    const rows = a
      ? (this.store.db
          .prepare("SELECT seq, http_status, created_at, summary_json FROM evidence WHERE attempt_id = ? AND evidence_class = 'PAYPAL_API_READBACK' ORDER BY seq")
          .all(a.id) as Array<{ seq: number; http_status: number | null; created_at: string; summary_json: string }>)
      : [];
    return {
      intentId: intent.id,
      intentSku: intent.sku,
      intentCurrency: intent.currency,
      intentMinor: intent.amount_minor,
      attemptId: a?.id ?? null,
      attemptState: a?.state ?? null,
      paypalOrderId: a?.paypal_order_id ?? null,
      captureId: a?.capture_id ?? null,
      captureStatus: a?.capture_status ?? null,
      capturedMinor: a?.captured_minor ?? null,
      capturedCurrency: a?.captured_currency ?? null,
      readbacks: rows.map(readbackFact),
      readbackFailures: a ? (this.store.db.prepare(`SELECT seq, created_at AS createdAt FROM evidence
        WHERE attempt_id = ? AND evidence_class = 'PAYPAL_API_RESPONSE' AND operation IN
        ('pre_capture_readback_error', 'post_capture_readback_error', 'reconcile_readback_error', 'readback_error', 'webhook_readback_error') ORDER BY seq`)
        .all(a.id) as Array<{ seq: number; createdAt: string }>) : [],
    };
  }

  evaluateIntent(orgId: string, intentId: string, runId = `run_${randomUUID()}`): IntentCheck {
    return this.store.tx(() => {
      const nowMs = this.options.now?.() ?? Date.now();
      if (!Number.isSafeInteger(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) throw new Error("invalid checker clock");
      const at = new Date(nowMs).toISOString();
      const intent = this.repo.intentInOrg(orgId, intentId);
      if (!intent) throw new Error("intent not found for this organization");
      const facts = this.#paymentFacts(intent);
      const orders = this.repo.effectiveOrdersForIntent(orgId, intentId);
      const baseEvaluation = evaluateContract(
        facts,
        orders.map((o) => ({ id: o.id, status: o.status, effectiveStatus: o.effective_status, attemptId: o.attempt_id, paypalOrderId: o.paypal_order_id, captureId: o.capture_id, sku: o.sku, amountMinor: o.amount_minor, currency: o.currency })),
      );
      const missing = assessMissingOrder(facts, baseEvaluation, nowMs, this.options.missingOrderGraceMs ?? DEFAULT_MISSING_ORDER_GRACE_MS);
      const ev = missing.evaluation;
      const factsSnapshot = {
        attemptId: facts.attemptId,
        attemptState: facts.attemptState,
        paypalOrderId: facts.paypalOrderId,
        captureId: facts.captureId,
        captureStatus: facts.captureStatus,
        readbackSeqs: facts.readbacks.map((r) => r.seq),
        readbackFailureSeqs: facts.readbackFailures?.map(r => r.seq) ?? [],
        confirmingReadbackSeqs: ev.confirmingReadbackSeqs,
        orderIds: orders.map((o) => o.id),
        matchingOrderIds: ev.matchingOrderIds,
        missingOrder: missing.timing,
      };
      const evalSeq = Number(
        this.store.db
          .prepare("INSERT INTO invariant_evaluations (organization_id, contract, intent_id, result, active_order_count, reasons_json, facts_json, run_id, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(orgId, CONTRACT_ID, intentId, ev.result, ev.activeOrderCount, JSON.stringify(ev.reasons), JSON.stringify(factsSnapshot), runId, at).lastInsertRowid,
      );
      const base = { intentId, evaluationSeq: evalSeq, result: ev.result, activeOrderCount: ev.activeOrderCount, reasons: ev.reasons };
      if (ev.result !== "VIOLATED") return { ...base, incidentId: null, incidentOpened: false, evidenceLinked: 0 };

      const faults = this.repo.faultsForIntent(orgId, intentId);
      const incidentClass = missing.violated ? MISSING_INCIDENT_CLASS : INCIDENT_CLASS;
      // Keep the original duplicate key stable. Missing and duplicate may occur at different times
      // for the same intent; neither is allowed to steal the other's incident or evidence.
      const dedupKey = `${orgId}|${CONTRACT_ID}|${intentId}${missing.violated ? `|${MISSING_INCIDENT_CLASS}` : ""}`;
      const involved = orders.filter((o) => ev.matchingOrderIds.includes(o.id));
      const duplicateCause = attributeCause(involved, faults);
      const reproduction = missing.violated ? {
        cause: "UNKNOWN", note: "Missing order observed; no causal mechanism established and no recovery authorized.",
        absenceObservation: { refType: "invariant_evaluation", refId: String(evalSeq), organizationId: orgId, intentId, matchingOrderIds: [], ...missing.timing },
      } : duplicateCause;
      const causalFaults = missing.violated ? [] : faults.filter((f) => duplicateCause.faultInjectionIds.includes(f.id));
      const incidentId = `inc_${randomUUID()}`;
      const opened =
        Number(
          this.store.db
            .prepare(
              `INSERT INTO incidents (id, organization_id, incident_class, contract, dedup_key, severity, state, intent_id, attempt_id, paypal_order_id, capture_id, title, opened_by_evaluation_seq, reproduction_json, opened_at)
               VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedup_key) DO NOTHING`,
            )
            .run(
              incidentId, orgId, incidentClass, CONTRACT_ID, dedupKey, DUPLICATE_SEVERITY, intentId, facts.attemptId, facts.paypalOrderId, facts.captureId,
              missing.violated ? "Captured PayPal payment without a merchant order after grace" : `${ev.matchingOrderIds.length} merchant orders for one captured PayPal payment`, evalSeq, JSON.stringify(reproduction), at,
            ).changes,
        ) === 1;
      const incident = this.store.db.prepare("SELECT id FROM incidents WHERE dedup_key = ?").get(dedupKey) as { id: string };
      const linked = this.#link(incident.id, this.#links(facts, ev.confirmingReadbackSeqs, orders, causalFaults, !missing.violated));
      return { ...base, incidentId: incident.id, incidentOpened: opened, evidenceLinked: linked };
    });
  }

  #links(facts: PaymentFacts, confirming: number[], orders: MerchantOrderRow[], faults: ReturnType<MerchantRepo["faultsForIntent"]>, includeWebhooks = true): Link[] {
    const links: Link[] = [];
    for (const r of facts.readbacks.filter((x) => confirming.includes(x.seq))) {
      const op = this.store.db.prepare("SELECT operation, paypal_debug_id FROM evidence WHERE seq = ?").get(r.seq) as { operation: string; paypal_debug_id: string | null };
      const c = r.units[0]!.captures[0]!;
      links.push({
        cls: "PAYPAL_API_READBACK",
        refType: "evidence",
        refId: String(r.seq),
        sourceAt: r.createdAt,
        summary: { operation: op.operation, httpStatus: r.httpStatus, paypalDebugId: op.paypal_debug_id, orderId: r.orderId, orderStatus: r.orderStatus, captureId: c.id, captureStatus: c.status, amount: { currency: c.currency, value: c.value } },
      });
    }
    const events = includeWebhooks && facts.attemptId
      ? (this.store.db
          .prepare(
            `SELECT w.event_id, w.event_type, w.event_create_time, w.outcome, w.first_delivery_seq, w.deliveries, d.reason AS verify_reason, d.verify_debug_id, w.created_at
             FROM webhook_events w JOIN webhook_deliveries d ON d.seq = w.first_delivery_seq
             WHERE w.attempt_id = ? AND w.state = 'processed' AND d.state = 'verified' ORDER BY w.created_at`,
          )
          .all(facts.attemptId) as Array<Record<string, string | number | null>>)
      : [];
    for (const e of events) {
      links.push({
        cls: "PAYPAL_VERIFIED_WEBHOOK",
        refType: "webhook_event",
        refId: String(e.event_id),
        sourceAt: (e.event_create_time as string | null) ?? (e.created_at as string),
        summary: { eventType: e.event_type, firstDeliverySeq: e.first_delivery_seq, deliveries: e.deliveries, verification: e.verify_reason, verifyDebugId: e.verify_debug_id, processingOutcome: e.outcome },
      });
    }
    for (const o of orders) {
      links.push({
        cls: "MERCHANT_DB_OBSERVED",
        refType: "merchant_order",
        refId: o.id,
        sourceAt: o.created_at,
        summary: { snapshot: o, observedAt: new Date().toISOString() },
      });
    }
    for (const f of faults) {
      links.push({ cls: "CONTROLLED_FAULT_INJECTION", refType: "fault_injection", refId: f.id, sourceAt: f.created_at, summary: { kind: f.kind, label: f.label, params: JSON.parse(f.params_json) as unknown } });
    }
    return links;
  }

  #link(incidentId: string, links: Link[]): number {
    const st = this.store.db.prepare(
      `INSERT INTO incident_evidence (incident_id, evidence_class, ref_type, ref_id, source_at, summary_json, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (incident_id, evidence_class, ref_id) DO NOTHING`,
    );
    let n = 0;
    const at = new Date().toISOString();
    for (const l of links) n += Number(st.run(incidentId, l.cls, l.refType, l.refId, l.sourceAt, JSON.stringify(l.summary), at).changes);
    return n;
  }

  evaluateAll(orgId: string): { runId: string; checks: IntentCheck[] } {
    const runId = `run_${randomUUID()}`;
    return { runId, checks: this.repo.listIntentIds(orgId).map((id) => this.evaluateIntent(orgId, id, runId)) };
  }
}
