import { ORG_ID, type IncidentEvidenceRow, type MerchantRepo } from "../merchant/repo.ts";
import { analyzeEvidence, type AdvisoryProvider, type AdvisoryResult } from "./advisory.ts";
import type { EvidenceItem, Scenario } from "./scenarios.ts";

type Citation = { id: string; trust: IncidentEvidenceRow["evidence_class"]; sourceRefType: string; sourceRefId: string };
type IncidentAdvisory = { authority: { incidentClass: string; scope: "HISTORICAL_OPENING_SNAPSHOT"; evaluatedAt: string }; citations: Citation[]; analysis: AdvisoryResult };
function object(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid snapshot");
  return value as Record<string, unknown>;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 40 || value.some(v => typeof v !== "string")) throw new Error("invalid references");
  return value as string[];
}

/** Headless, read-only boundary. Organization scope is supplied by trusted caller, NOT authentication.
 * No routes or credentials are installed. Pass a provider only after account/cost/privacy approval.
 * Only opening-evaluation snapshots are analyzed: no claim of current provider/merchant truth.
 */
export class IncidentAdvisoryService {
  constructor(private readonly repo: MerchantRepo, private readonly opts: { provider?: AdvisoryProvider } = {}) {}
  async analyze(org: string, id: string): Promise<IncidentAdvisory | null> {
    if (!ORG_ID.test(org) || !/^inc_[a-zA-Z0-9_-]{1,80}$/.test(id)) return null;
    const incident = this.repo.getIncident(org, id);
    if (!incident) return null;
    const evaluation = this.repo.getEvaluation(org, incident.opened_by_evaluation_seq);
    const authority: IncidentAdvisory["authority"] = { incidentClass: incident.incident_class, scope: "HISTORICAL_OPENING_SNAPSHOT", evaluatedAt: evaluation?.evaluated_at ?? incident.opened_at };
    try {
      if (!evaluation || evaluation.intent_id !== incident.intent_id || evaluation.result !== "VIOLATED" ||
          !["DUPLICATE_MERCHANT_ORDER", "MISSING_MERCHANT_ORDER"].includes(incident.incident_class)) throw new Error("invalid opening evaluation");
      const facts = object(evaluation.facts_json);
      const readbacks = facts.confirmingReadbackSeqs;
      if (!Array.isArray(readbacks) || !readbacks.length || readbacks.length > 40 || readbacks.some(n => !Number.isSafeInteger(n))) throw new Error("invalid readback references");
      const orderIds = strings(facts.matchingOrderIds);
      if ((incident.incident_class === "MISSING_MERCHANT_ORDER" && orderIds.length !== 0) || (incident.incident_class === "DUPLICATE_MERCHANT_ORDER" && orderIds.length < 2)) throw new Error("inconsistent opening class");
      // Bound the OPENING references, not the lifetime history: later observations must not
      // exhaust an immutable snapshot's budget or silently replace its facts.
      const rows = this.repo.db.prepare(`SELECT * FROM incident_evidence WHERE incident_id=? AND (
        (evidence_class='PAYPAL_API_READBACK' AND ref_type='evidence' AND ref_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))) OR
        (evidence_class='MERCHANT_DB_OBSERVED' AND ref_type='merchant_order' AND ref_id IN (SELECT value FROM json_each(?)))
      ) ORDER BY seq LIMIT 81`).all(id, JSON.stringify(readbacks), JSON.stringify(orderIds)) as IncidentEvidenceRow[];
      if (rows.length > 80) throw new Error("evidence budget exceeded");
      const providerRows = rows.filter(r => r.evidence_class === "PAYPAL_API_READBACK" && r.ref_type === "evidence" && readbacks.includes(Number(r.ref_id)));
      if (providerRows.length !== new Set(readbacks).size) throw new Error("missing readback snapshot");
      for (const r of providerRows) {
        const p = object(r.summary_json);
        if (p.httpStatus !== 200 || p.orderId !== incident.paypal_order_id || p.captureId !== incident.capture_id || p.captureStatus !== "COMPLETED") throw new Error("inconsistent readback snapshot");
      }
      const evidence: EvidenceItem[] = []; const citations: Citation[] = [];
      const add = (r: IncidentEvidenceRow, fact: EvidenceItem["fact"]) => {
        const alias = `E${evidence.length + 1}`;
        if (!r.source_at || !Number.isFinite(Date.parse(r.source_at)) || Date.parse(r.source_at) > Date.parse(evaluation.evaluated_at)) throw new Error("invalid source time");
        evidence.push({ id: alias, cls: r.evidence_class, at: r.source_at, fact });
        citations.push({ id: alias, trust: r.evidence_class, sourceRefType: r.ref_type, sourceRefId: r.ref_id });
      };
      // Multiple agreeing confirmations of the SAME capture are not multiple captures.
      const newest = providerRows.at(-1)!;
      add(newest, { kind: "capture", paypal_order_ref: "PAYMENT", capture_status: "COMPLETED" });
      for (const orderId of orderIds) {
        const row = rows.find(r => r.evidence_class === "MERCHANT_DB_OBSERVED" && r.ref_type === "merchant_order" && r.ref_id === orderId);
        if (!row) throw new Error("missing merchant snapshot");
        const p = object(row.summary_json); const m = p.snapshot as Record<string, unknown> | undefined;
        if (!m || m.id !== orderId || m.organization_id !== org || m.intent_id !== incident.intent_id || m.paypal_order_id !== incident.paypal_order_id || m.capture_id !== incident.capture_id) throw new Error("invalid merchant scope");
        add(row, { kind: "merchant_order_created", paypal_order_ref: "PAYMENT", merchant_order_id: `ORDER${evidence.length}` });
      }
      let graceSeconds = 300;
      if (incident.incident_class === "MISSING_MERCHANT_ORDER") {
        const timing = facts.missingOrder as Record<string, unknown> | undefined;
        const due = typeof timing?.dueAt === "string" ? Date.parse(timing.dueAt) : NaN;
        if (!Number.isFinite(due) || due > Date.parse(evaluation.evaluated_at)) throw new Error("invalid grace evidence");
        // Preserve the recorded first-confirmation deadline; never reset grace at latest readback.
        graceSeconds = Math.max(0, (due - Date.parse(newest.source_at!)) / 1000);
        const alias = `E${evidence.length + 1}`;
        evidence.push({ id: alias, cls: "MERCHANT_DB_OBSERVED", at: evaluation.evaluated_at,
          fact: { kind: "merchant_order_absence", paypal_order_ref: "PAYMENT", matching_order_count: 0 } });
        citations.push({ id: alias, trust: "MERCHANT_DB_OBSERVED", sourceRefType: "invariant_evaluation", sourceRefId: String(evaluation.seq) });
      }
      const scenario: Scenario = { id: "INCIDENT_SNAPSHOT", title: "Redacted historical opening evidence", observedAt: evaluation.evaluated_at, graceSeconds, evidence };
      return { authority, citations, analysis: await analyzeEvidence(scenario, this.opts) };
    } catch {
      return { authority, citations: [], analysis: { status: "AI_UNAVAILABLE", trust: "DETERMINISTIC_GUIDANCE", reason: "INVALID_CONTEXT", advice: [{ hypothesis: "Opening evidence is incomplete or inconsistent; no AI diagnosis is available.", uncertainty: "Inspect the opening evaluation and its source references locally.", evidenceIds: [], nextTest: "REQUEST_MORE_EVIDENCE" }], metrics: { calls: 0, latencyMs: 0, provider: null } } };
    }
  }
}
