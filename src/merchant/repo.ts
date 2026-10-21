import type { Store } from "../db/store.ts";

/** Organization ids are opaque, lowercase, prefixed. Checked before any query. */
export const ORG_ID = /^org_[a-z0-9_]{1,40}$/;
export const REFERENCE_ORG = "org_reference";

export type MerchantOrderRow = {
  id: string;
  organization_id: string;
  intent_id: string;
  attempt_id: string;
  paypal_order_id: string;
  capture_id: string;
  sku: string;
  currency: string;
  amount_minor: number;
  status: string;
  created_by_path: "capture_return" | "webhook_capture_completed";
  fault_injection_id: string | null;
  created_at: string;
};

export type FaultInjectionRow = { id: string; organization_id: string; label: "CONTROLLED_FAULT_INJECTION"; kind: string; intent_id: string; params_json: string; created_at: string };

export type IncidentRow = {
  id: string;
  organization_id: string;
  incident_class: string;
  contract: string;
  dedup_key: string;
  severity: string;
  state: string;
  intent_id: string;
  attempt_id: string;
  paypal_order_id: string;
  capture_id: string;
  title: string;
  opened_by_evaluation_seq: number;
  reproduction_json: string;
  opened_at: string;
};

export type IncidentEvidenceRow = {
  seq: number;
  incident_id: string;
  evidence_class: "PAYPAL_API_READBACK" | "PAYPAL_VERIFIED_WEBHOOK" | "MERCHANT_DB_OBSERVED" | "CONTROLLED_FAULT_INJECTION";
  ref_type: string;
  ref_id: string;
  source_at: string | null;
  summary_json: string;
  linked_at: string;
};

export type EvaluationRow = {
  seq: number;
  organization_id: string;
  contract: string;
  intent_id: string;
  result: string;
  active_order_count: number;
  reasons_json: string;
  facts_json: string;
  run_id: string;
  evaluated_at: string;
};

/** Organization-scoped reads. Every query takes the organization id; none can cross it. */
export class MerchantRepo {
  constructor(readonly store: Store) {}

  get db() {
    return this.store.db;
  }

  organizationExists(orgId: string): boolean {
    return ORG_ID.test(orgId) && !!this.db.prepare("SELECT 1 FROM organizations WHERE id = ?").get(orgId);
  }

  createOrganization(id: string, name: string) {
    if (!ORG_ID.test(id)) throw new Error("invalid organization id");
    this.db.prepare("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)").run(id, name, new Date().toISOString());
  }

  intentInOrg(orgId: string, intentId: string) {
    return this.db.prepare("SELECT * FROM checkout_intents WHERE id = ? AND organization_id = ?").get(intentId, orgId) as
      | { id: string; sku: string; currency: string; amount_minor: number; organization_id: string; created_at: string }
      | undefined;
  }

  listIntentIds(orgId: string): string[] {
    return (this.db.prepare("SELECT id FROM checkout_intents WHERE organization_id = ? ORDER BY created_at, id").all(orgId) as Array<{ id: string }>).map((r) => r.id);
  }

  ordersForIntent(orgId: string, intentId: string): MerchantOrderRow[] {
    return this.db.prepare("SELECT * FROM merchant_orders WHERE organization_id = ? AND intent_id = ? ORDER BY created_at, id").all(orgId, intentId) as MerchantOrderRow[];
  }

  faultsForIntent(orgId: string, intentId: string): FaultInjectionRow[] {
    return this.db.prepare("SELECT * FROM fault_injections WHERE organization_id = ? AND intent_id = ? ORDER BY created_at, id").all(orgId, intentId) as FaultInjectionRow[];
  }

  effectiveOrdersForIntent(orgId: string, intentId: string): Array<MerchantOrderRow & { effective_status: string }> {
    return this.db.prepare(`SELECT m.*, CASE WHEN v.order_id IS NULL THEN m.status ELSE 'voided_duplicate' END AS effective_status
      FROM merchant_orders m LEFT JOIN merchant_order_voids v ON v.order_id = m.id
      WHERE m.organization_id = ? AND m.intent_id = ? ORDER BY m.created_at, m.id`).all(orgId, intentId) as Array<MerchantOrderRow & { effective_status: string }>;
  }

  incidentState(incidentId: string): string {
    return this.db.prepare("SELECT 1 FROM incident_resolutions WHERE incident_id = ?").get(incidentId) ? "resolved_verified" : "open";
  }

  listIncidents(orgId: string): IncidentRow[] {
    return this.db.prepare("SELECT * FROM incidents WHERE organization_id = ? ORDER BY opened_at, id").all(orgId) as IncidentRow[];
  }

  getIncident(orgId: string, id: string): IncidentRow | undefined {
    return this.db.prepare("SELECT * FROM incidents WHERE organization_id = ? AND id = ?").get(orgId, id) as IncidentRow | undefined;
  }

  incidentEvidence(incidentId: string): IncidentEvidenceRow[] {
    return this.db.prepare("SELECT * FROM incident_evidence WHERE incident_id = ? ORDER BY seq").all(incidentId) as IncidentEvidenceRow[];
  }

  getEvaluation(orgId: string, seq: number): EvaluationRow | undefined {
    return this.db.prepare("SELECT * FROM invariant_evaluations WHERE organization_id = ? AND seq = ?").get(orgId, seq) as EvaluationRow | undefined;
  }

  latestEvaluation(orgId: string, intentId: string): EvaluationRow | undefined {
    return this.db.prepare("SELECT * FROM invariant_evaluations WHERE organization_id = ? AND intent_id = ? ORDER BY seq DESC LIMIT 1").get(orgId, intentId) as EvaluationRow | undefined;
  }

  /** Newest evaluation per intent for the organization. */
  latestEvaluations(orgId: string): EvaluationRow[] {
    return this.db
      .prepare(
        `SELECT e.* FROM invariant_evaluations e
         JOIN (SELECT intent_id, MAX(seq) AS seq FROM invariant_evaluations WHERE organization_id = ? GROUP BY intent_id) m ON m.seq = e.seq
         ORDER BY e.seq`,
      )
      .all(orgId) as EvaluationRow[];
  }
}
