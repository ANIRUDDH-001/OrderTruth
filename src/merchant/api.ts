import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Store } from "../db/store.ts";
import { MerchantRepo, ORG_ID, type IncidentRow } from "./repo.ts";
import { RepairService } from "./repair.ts";
import { MISSING_INCIDENT_CLASS } from "./missing-order.ts";
import { IncidentAdvisoryService } from "../ai/incident-advisory.ts";

/**
 * DEV-ONLY ORGANIZATION SCOPE, NOT AUTHENTICATION. The caller names its organization in this
 * header; every query is filtered by it, and another organization's incident is indistinguishable
 * from a missing one (404). A real identity/RBAC layer must replace this before any exposure.
 */
export const ORG_HEADER = "x-ordertruth-org";
const INCIDENT_ID = /^inc_[0-9a-f-]{36}$/;
const INTENT_ID = /^ci_[0-9a-f-]{36}$/;

const parse = (s: string): unknown => JSON.parse(s);

function incidentView(repo: MerchantRepo, i: IncidentRow) {
  const evidence = repo.incidentEvidence(i.id).map((e) => ({
    seq: e.seq,
    evidenceClass: e.evidence_class,
    ref: { type: e.ref_type, id: e.ref_id },
    sourceAt: e.source_at,
    linkedAt: e.linked_at,
    summary: parse(e.summary_json),
  }));
  const affected = repo.effectiveOrdersForIntent(i.organization_id, i.intent_id).map((o) => ({
    id: o.id,
    status: o.status,
    effectiveStatus: o.effective_status,
    createdByPath: o.created_by_path,
    createdAt: o.created_at,
    amount: { currency: o.currency, minor: o.amount_minor },
    faultInjectionId: o.fault_injection_id,
    provenance: o.fault_injection_id ? "CONTROLLED_FAULT_INJECTION" : "REFERENCE_MERCHANT_FLOW",
  }));
  const opening = repo.getEvaluation(i.organization_id, i.opened_by_evaluation_seq);
  const latest = repo.latestEvaluation(i.organization_id, i.intent_id);
  const evalView = (e: typeof opening) => e && { seq: e.seq, result: e.result, activeOrderCount: e.active_order_count, reasons: parse(e.reasons_json), facts: parse(e.facts_json), evaluatedAt: e.evaluated_at, runId: e.run_id };
  const intent = repo.intentInOrg(i.organization_id, i.intent_id);
  // Incident-specific append-only links, distinct from the intent's latest check.
  const voids = repo.db.prepare(`SELECT v.* FROM merchant_order_voids v
    JOIN repair_executions e ON e.id=v.execution_id JOIN repair_plans p ON p.id=e.plan_id
    WHERE p.incident_id=? AND p.organization_id=? ORDER BY v.created_at,v.order_id`).all(i.id,i.organization_id);
  const resolutions = (repo.db.prepare(`SELECT r.* FROM incident_resolutions r
    JOIN incidents x ON x.id=r.incident_id WHERE x.id=? AND x.organization_id=?`).all(i.id,i.organization_id) as Array<{evaluation_seq:number}>)
    .map(row=>({...row,postcondition:evalView(repo.getEvaluation(i.organization_id,row.evaluation_seq))}));
  return {
    id: i.id,
    organizationId: i.organization_id,
    class: i.incident_class,
    contract: i.contract,
    severity: i.severity,
    state: repo.incidentState(i.id),
    historicalState: i.state,
    repairHistory: {...new RepairService(repo.store, i.organization_id).history(i.id),voids,resolutions},
    title: i.title,
    openedAt: i.opened_at,
    payment: { intentId: i.intent_id, attemptId: i.attempt_id, paypalOrderId: i.paypal_order_id, captureId: i.capture_id },
    openingEvaluation: evalView(opening),
    latestEvaluation: evalView(latest),
    affectedOrders: affected,
    evidenceCounts: evidence.reduce<Record<string, number>>((m, e) => ((m[e.evidenceClass] = (m[e.evidenceClass] ?? 0) + 1), m), {}),
    evidence,
    reproduction: parse(i.reproduction_json),
    ...(i.incident_class === MISSING_INCIDENT_CLASS ? { missingOrder: {
      impact: { currency: intent?.currency, minor: intent?.amount_minor, description: "Captured payment had no effective merchant order at detection; fulfillment may be delayed. This is not proof of financial loss." },
      absenceEvidence: { type: "invariant_evaluation", id: String(i.opened_by_evaluation_seq) },
      lastCheckedCondition: latest?.result === "HOLDS" ? "ORDER_PRESENT" : latest?.result === "VIOLATED" && latest.active_order_count === 0 ? "MISSING_AFTER_GRACE" : "RECHECK_REQUIRED",
      recoverySupported: false,
      nextAction: "Inspect the opening and latest evaluations, persisted readbacks and merchant state. A late order does not erase the historical incident. Recovery requires separate authorization; do not automatically create an order or use duplicate-order repair.",
    } } : {}),
  };
}

export async function buildIncidentApi(o: { store: Store; logger?: boolean }): Promise<FastifyInstance> {
  const repo = new MerchantRepo(o.store);
  const app = Fastify({ logger: o.logger ?? false, bodyLimit: 1024 });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
  });
  // Read-only surface: anything but GET is refused before routing.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD") return reply.status(405).header("allow", "GET").send({ error: "method_not_allowed" });
  });

  const org = (req: FastifyRequest): string | null => {
    const h = req.headers[ORG_HEADER];
    return typeof h === "string" && ORG_ID.test(h) && repo.organizationExists(h) ? h : null;
  };
  const deny = { error: "organization_required", note: `dev-only ${ORG_HEADER} scope header; not authentication` };

  app.get("/api/incidents", async (req, reply) => {
    const id = org(req);
    if (!id) return reply.status(401).send(deny);
    return {
      organizationId: id,
      incidents: repo.listIncidents(id).map((i) => ({
        id: i.id,
        class: i.incident_class,
        severity: i.severity,
        state: repo.incidentState(i.id),
        title: i.title,
        openedAt: i.opened_at,
        intentId: i.intent_id,
        paypalOrderId: i.paypal_order_id,
        captureId: i.capture_id,
        affectedOrderCount: repo.ordersForIntent(id, i.intent_id).length,
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/incidents/:id", async (req, reply) => {
    const id = org(req);
    if (!id) return reply.status(401).send(deny);
    if (!INCIDENT_ID.test(req.params.id)) return reply.status(400).send({ error: "invalid_incident_id" });
    const i = repo.getIncident(id, req.params.id);
    if (!i) return reply.status(404).send({ error: "not_found" });
    return incidentView(repo, i);
  });

  // Rules-only: no provider is wired here, so no model call or credential can be reached from a browser.
  const advisory = new IncidentAdvisoryService(repo);
  app.get<{ Params: { id: string } }>("/api/incidents/:id/advisory", async (req, reply) => {
    const id = org(req);
    if (!id) return reply.status(401).send(deny);
    if (!INCIDENT_ID.test(req.params.id)) return reply.status(400).send({ error: "invalid_incident_id" });
    const result = await advisory.analyze(id, req.params.id);
    if (!result) return reply.status(404).send({ error: "not_found" });
    return { incidentId: req.params.id, organizationId: id, providerConfigured: false, ...result };
  });

  app.get<{ Querystring: { intentId?: string } }>("/api/evaluations", async (req, reply) => {
    const id = org(req);
    if (!id) return reply.status(401).send(deny);
    const intent = req.query.intentId;
    if (intent !== undefined && !INTENT_ID.test(intent)) return reply.status(400).send({ error: "invalid_intent_id" });
    const rows = intent ? [repo.latestEvaluation(id, intent)].filter((r) => r !== undefined) : repo.latestEvaluations(id);
    return {
      organizationId: id,
      evaluations: rows.map((e) => {
        const ci = repo.intentInOrg(id, e.intent_id);
        return { seq: e.seq, contract: e.contract, intentId: e.intent_id, result: e.result, activeOrderCount: e.active_order_count, reasons: parse(e.reasons_json), facts: parse(e.facts_json), evaluatedAt: e.evaluated_at,
          checkout: ci ? { sku: ci.sku, amount: { currency: ci.currency, minor: ci.amount_minor }, createdAt: ci.created_at } : null };
      }),
    };
  });

  return app;
}
