import { randomUUID } from "node:crypto";
import type { Store } from "../db/store.ts";
import { CONTRACT_ID, DUPLICATE_SEVERITY, evaluateContract, INCIDENT_CLASS, readbackFact, type EvaluationResult, type PaymentFacts } from "./contract.ts";
import { MerchantRepo, type IncidentEvidenceRow, type MerchantOrderRow } from "./repo.ts";

export type IntentCheck = { intentId: string; evaluationSeq: number; result: EvaluationResult; activeOrderCount: number; reasons: string[]; incidentId: string | null; incidentOpened: boolean; evidenceLinked: number };

type Link = { cls: IncidentEvidenceRow["evidence_class"]; refType: string; refId: string; sourceAt: string | null; summary: unknown };

/**
 * Deterministic invariant checker. Reads only local records: the authoritative PayPal evidence the
 * payment flow already persisted (PAYPAL_API_READBACK rows, PayPal-verified webhook events) and the
 * merchant's own orders. It never calls PayPal and never changes payment or merchant state.
 * Each evaluation is recorded; only VIOLATED opens an incident, at most one per intent (dedup key),
 * and re-running only appends evidence not linked yet. One transaction per intent.
 */
export class InvariantChecker {
  readonly repo: MerchantRepo;

  constructor(readonly store: Store) {
    this.repo = new MerchantRepo(store);
  }

  #paymentFacts(intent: { id: string; currency: string; amount_minor: number }): PaymentFacts {
    const a = this.store.getAttemptByIntentId(intent.id);
    const rows = a
      ? (this.store.db
          .prepare("SELECT seq, http_status, created_at, summary_json FROM evidence WHERE attempt_id = ? AND evidence_class = 'PAYPAL_API_READBACK' ORDER BY seq")
          .all(a.id) as Array<{ seq: number; http_status: number | null; created_at: string; summary_json: string }>)
      : [];
    return {
      intentId: intent.id,
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
    };
  }

  evaluateIntent(orgId: string, intentId: string, runId = `run_${randomUUID()}`): IntentCheck {
    return this.store.tx(() => {
      const intent = this.repo.intentInOrg(orgId, intentId);
      if (!intent) throw new Error("intent not found for this organization");
      const facts = this.#paymentFacts(intent);
      const orders = this.repo.ordersForIntent(orgId, intentId);
      const ev = evaluateContract(
        facts,
        orders.map((o) => ({ id: o.id, status: o.status, captureId: o.capture_id, amountMinor: o.amount_minor, currency: o.currency })),
      );
      const factsSnapshot = {
        attemptId: facts.attemptId,
        attemptState: facts.attemptState,
        paypalOrderId: facts.paypalOrderId,
        captureId: facts.captureId,
        captureStatus: facts.captureStatus,
        readbackSeqs: facts.readbacks.map((r) => r.seq),
        confirmingReadbackSeqs: ev.confirmingReadbackSeqs,
        orderIds: orders.map((o) => o.id),
      };
      const at = new Date().toISOString();
      const evalSeq = Number(
        this.store.db
          .prepare("INSERT INTO invariant_evaluations (organization_id, contract, intent_id, result, active_order_count, reasons_json, facts_json, run_id, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(orgId, CONTRACT_ID, intentId, ev.result, ev.activeOrderCount, JSON.stringify(ev.reasons), JSON.stringify(factsSnapshot), runId, at).lastInsertRowid,
      );
      const base = { intentId, evaluationSeq: evalSeq, result: ev.result, activeOrderCount: ev.activeOrderCount, reasons: ev.reasons };
      if (ev.result !== "VIOLATED") return { ...base, incidentId: null, incidentOpened: false, evidenceLinked: 0 };

      const faults = this.repo.faultsForIntent(orgId, intentId);
      const dedupKey = `${orgId}|${CONTRACT_ID}|${intentId}`;
      const reproduction = faults.length
        ? {
            cause: "CONTROLLED_FAULT_INJECTION",
            faultInjectionIds: faults.map((f) => f.id),
            kind: faults.map((f) => f.kind),
            mechanism: "REF-BUG-1: reference merchant check-then-insert without unique key; capture_return and webhook_capture_completed paths both pass the existence check before either inserts",
            reproduce: "pnpm stage1c --mode fault --target-order <PayPal order id> (isolated DB copy) or pnpm exec vitest run tests/stage1c-merchant-incident.test.ts",
          }
        : { cause: "UNKNOWN", note: "no controlled fault recorded for this intent; duplicate observed in merchant data", orderCreationPaths: orders.map((o) => o.created_by_path) };
      const incidentId = `inc_${randomUUID()}`;
      const opened =
        Number(
          this.store.db
            .prepare(
              `INSERT INTO incidents (id, organization_id, incident_class, contract, dedup_key, severity, state, intent_id, attempt_id, paypal_order_id, capture_id, title, opened_by_evaluation_seq, reproduction_json, opened_at)
               VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedup_key) DO NOTHING`,
            )
            .run(
              incidentId, orgId, INCIDENT_CLASS, CONTRACT_ID, dedupKey, DUPLICATE_SEVERITY, intentId, facts.attemptId, facts.paypalOrderId, facts.captureId,
              `${ev.activeOrderCount} merchant orders for one captured PayPal payment`, evalSeq, JSON.stringify(reproduction), at,
            ).changes,
        ) === 1;
      const incident = this.store.db.prepare("SELECT id FROM incidents WHERE dedup_key = ?").get(dedupKey) as { id: string };
      const linked = this.#link(incident.id, this.#links(facts, ev.confirmingReadbackSeqs, orders, faults));
      return { ...base, incidentId: incident.id, incidentOpened: opened, evidenceLinked: linked };
    });
  }

  #links(facts: PaymentFacts, confirming: number[], orders: MerchantOrderRow[], faults: ReturnType<MerchantRepo["faultsForIntent"]>): Link[] {
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
    const events = facts.attemptId
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
