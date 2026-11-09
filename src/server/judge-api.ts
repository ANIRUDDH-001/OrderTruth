import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { createSessionAuth } from "./auth.ts";
import { sessionIdentity } from "./session-api.ts";
import { PostgresScenarioStore, ScenarioCreationRejection, validScenarioOperation } from "../merchant/postgres-scenarios.ts";
import { PostgresRecoveryService } from "../merchant/postgres-recovery.ts";
import { PostgresInvestigationStore } from "../ai/postgres-investigation.ts";
import {readInvestigationHistory,type PostgresInvestigationService} from "../ai/postgres-investigation-service.ts";
import { diagnosticKinds,deterministicInvestigator } from "../ai/investigation.ts";
import { admitDemoAction } from "./demo-limits.ts";
import { NETWORK_PROOF_HEADER, verifyNetwork } from "./network-attribution.ts";

/** Public judge routes never receive a payment provider or a model that can
 * mutate money. Identity and run ownership come from persisted sessions. */
export function registerJudgeApi(app: FastifyInstance, options: {
  pool: Pool; schema: string; auth: ReturnType<typeof createSessionAuth>; origin: string; sourceAttemptId: string | null; investigator?: PostgresInvestigationService; ingressKey?: string | undefined;
}) {
  const scenarios = new PostgresScenarioStore(options.pool,options.schema);
  const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
  const empty = z.object({}).strict();
  const operation = z.string().refine(validScenarioOperation);
  const creationBody = z.object({ operationId: operation,caseKind:z.enum(['DUPLICATE','MISSING']).default('DUPLICATE') }).strict();
  const planBody = z.object({ planId: id }).strict();
  const approvalBody = z.object({ planId: id,planSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
  const investigationStore = new PostgresInvestigationStore(options.pool,options.schema);
  app.register(async routes => {
    routes.addHook("onRequest", async (request,reply) => {
      reply.header("cache-control","no-store");
      if (request.method === "POST" && request.headers.origin !== options.origin) return reply.code(403).send({ error: "Same-origin request required" });
    });
    routes.setErrorHandler((error,_request,reply) => {
      if (_request.routeOptions.url === "/api/scenario-operations/:operationId") return reply.code(503).send({
        error: "Creation outcome unknown; reconcile the same operation identity",outcome: "UNKNOWN",code: "CREATION_OUTCOME_UNKNOWN",
      });
      if (_request.routeOptions.url === "/api/scenarios" && _request.method === "POST") {
        const status = (error as { statusCode?: number }).statusCode;
        if (status && status >= 400 && status < 500) return reply.code(status).send({ error: "Invalid creation request",outcome: "REJECTED",code: "INVALID_OPERATION_ID" });
        return reply.code(503).send({ error: "Creation outcome unknown; reconcile the same operation identity",outcome: "UNKNOWN",code: "CREATION_OUTCOME_UNKNOWN" });
      }
      const message = error instanceof Error ? error.message : "";
      if (/not found/i.test(message)) return reply.code(404).send({ error: "Scenario not found" });
      if (_request.routeOptions.url?.endsWith("/approve") && /stale|eligible|expired/i.test(message)) return reply.code(409).send({
        code: "PLAN_REVIEW_REQUIRED", error: "The saved plan can no longer be approved. Recheck the case, then review a new exact plan when the duplicate and payment evidence support it.",
      });
      if (/hash|expired|stale|eligible|identity differs/i.test(message)) return reply.code(409).send({ error: "Case changed; recheck before approval" });
      if (/admission limit/i.test(message)) return reply.code(429).send({ error: "Scenario capacity reached; existing receipts remain available" });
      return reply.code(503).send({ error: "Scenario unavailable; committed evidence and receipts are preserved" });
    });
    routes.get("/api/readiness",async (_request,reply) => {
      try {
        const version = (await options.pool.query(`SELECT max(version) AS version FROM ${options.schema}.ordertruth_postgres_migrations`)).rows[0]?.version;
        if (version !== 9) return reply.code(503).send({ ready: false });
        return { ready: true,persistence: "postgresql",schemaVersion: 9,backendContract: "phase1-core-v1" };
      } catch { return reply.code(503).send({ ready: false }); }
    });
    const unknownCreation = (reply: import("fastify").FastifyReply) => reply.code(503).send({
      error: "Creation outcome unknown; reconcile the same operation identity", outcome: "UNKNOWN", code: "CREATION_OUTCOME_UNKNOWN",
    });
    routes.get<{ Params: { operationId: string } }>("/api/scenario-operations/:operationId", async (request,reply) => {
      const identity = await sessionIdentity(options.auth,request); if (!identity) return reply.code(401).send({ error: "Session required" });
      if (!operation.safeParse(request.params.operationId).success) return reply.code(400).send({ error: "Invalid operation identity",outcome: "REJECTED",code: "INVALID_OPERATION_ID" });
      try {
        const scenario = await scenarios.lookupOperation(identity.userId,request.params.operationId);
        return { operationId: request.params.operationId,outcome: scenario ? "COMMITTED" : "UNKNOWN",scenario };
      } catch { request.log.warn({ evt: "scenario_creation_reconcile_unknown",requestId: request.id }); return unknownCreation(reply); }
    });
    routes.post("/api/scenarios", { bodyLimit: 4096 }, async (request,reply) => {
      const identity = await sessionIdentity(options.auth,request); if (!identity) return reply.code(401).send({ error: "Start a judge session first" });
      const parsed = creationBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "A UUID v4 operation identity is required; no payment or price overrides",outcome: "REJECTED",code: "INVALID_OPERATION_ID" });
      const operationId = parsed.data.operationId;
      try {
        // Resolve committed operations before discovering/validating today's source.
        const existing = await scenarios.lookupOperation(identity.userId,operationId,parsed.data.caseKind);
        if (existing) return { ...existing,creation: { operationId,outcome: "COMMITTED" } };
        const source = options.sourceAttemptId ?? (await options.pool.query(`SELECT a.id FROM ${options.schema}.payment_attempts a
          JOIN ${options.schema}.evidence e ON e.attempt_id=a.id WHERE a.state='captured' AND e.evidence_class='PAYPAL_API_READBACK'
          AND e.http_status=200 AND e.summary_json::jsonb->>'provenance'='PAYPAL_SANDBOX_GET' ORDER BY e.seq DESC LIMIT 1`)).rows[0]?.id as string | undefined;
        // Even no-source requests enter same-key serialization: a prior request
        // may have committed since the read above, in which case it wins.
        const run = await scenarios.create(identity.userId,source ?? "",operationId,parsed.data.caseKind);
        return { ...await scenarios.get(identity.userId,run.id),creation: { operationId,outcome: "COMMITTED" } };
      } catch (error) {
        if (error instanceof ScenarioCreationRejection) return reply.code(error.code==='OPERATION_KIND_MISMATCH'?409:error.code === "SCENARIO_CAPACITY" ? 429 : 503).send({
          error: error.code==='OPERATION_KIND_MISMATCH'?'This operation already belongs to a different case type':error.code === "SCENARIO_CAPACITY" ? "Scenario capacity reached; existing receipts remain available" : "An owner-approved Sandbox observation is not available yet",
          outcome: "REJECTED",code: error.code,
        });
        request.log.warn({ evt: "scenario_creation_unknown",requestId: request.id });
        return unknownCreation(reply);
      }
    });
    routes.get<{ Params: { runId: string } }>("/api/scenarios/:runId", async (request,reply) => {
      const identity = await sessionIdentity(options.auth,request); if (!identity) return reply.code(401).send({ error: "Session required" });
      if (!id.safeParse(request.params.runId).success) return reply.code(400).send({ error: "Invalid scenario" });
      return scenarios.get(identity.userId,request.params.runId);
    });
    for (const action of ["duplicate","check","plan","approve","execute"] as const) routes.post<{ Params: { runId: string } }>(`/api/scenarios/:runId/${action}`, { bodyLimit: 4096 }, async (request,reply) => {
      const identity = await sessionIdentity(options.auth,request); if (!identity) return reply.code(401).send({ error: "Session required" });
      if (!id.safeParse(request.params.runId).success) return reply.code(400).send({ error: "Invalid scenario" });
      const bodySchema = action === "approve" ? approvalBody : action === "execute" ? planBody : empty;
      const parsed = bodySchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "Invalid scenario action" });
      const current = await scenarios.get(identity.userId,request.params.runId);
      if (!await admitDemoAction(options.pool,options.schema,identity.userId,current.run.id)) return reply.code(429).send({ error: "Demo action allowance reached; existing receipts remain readable" });
      const service = new PostgresRecoveryService(options.pool,options.schema,{ runId: current.run.id,userId: identity.userId });
      if (action === "duplicate") { await scenarios.injectDuplicate(identity.userId,current.run.id); return scenarios.get(identity.userId,current.run.id); }
      if (action === "check") return service.check(current.organizationId,current.intentId);
      if (action === "plan") {
        const checked = await service.check(current.organizationId,current.intentId);
        if (!checked.incidentId) return reply.code(409).send({ error: "No duplicate incident is currently actionable" });
        return service.plan(current.organizationId,checked.incidentId,identity.userId);
      }
      if (action === "approve") {
        const body = approvalBody.parse(parsed.data);
        await service.approveSession(current.organizationId,body.planId,body.planSha256);
        return { approved: true,planId: body.planId,planSha256: body.planSha256 };
      }
      return service.execute(current.organizationId,planBody.parse(parsed.data).planId);
    });
    routes.get<{ Params: { runId: string; planId: string } }>("/api/scenarios/:runId/receipts/:planId", async (request,reply) => {
      const identity = await sessionIdentity(options.auth,request); if (!identity) return reply.code(401).send({ error: "Session required" });
      if (!id.safeParse(request.params.runId).success || !id.safeParse(request.params.planId).success) return reply.code(400).send({ error: "Invalid receipt" });
      const current = await scenarios.get(identity.userId,request.params.runId);
      return new PostgresRecoveryService(options.pool,options.schema,{ runId: current.run.id,userId: identity.userId }).verify(current.organizationId,request.params.planId);
    });
    routes.get<{ Params: { runId: string } }>("/api/scenarios/:runId/investigation", async (request,reply) => {
      const identity = await sessionIdentity(options.auth,request); if (!identity) return reply.code(401).send({ error: "Session required" });
      if (!id.safeParse(request.params.runId).success) return reply.code(400).send({ error: "Invalid investigation" });
      return readInvestigationHistory(options.pool,options.schema,identity.userId,request.params.runId);
    });
    routes.post<{ Params: { runId: string } }>("/api/scenarios/:runId/investigate", { bodyLimit: 4096 }, async (request,reply) => {
      const identity = await sessionIdentity(options.auth,request); if (!identity) return reply.code(401).send({ error: "Session required" });
      if (!id.safeParse(request.params.runId).success || !empty.safeParse(request.body).success) return reply.code(400).send({ error: "Invalid investigation" });
      if (options.investigator) {
        const group = identity.anonymous && options.ingressKey ? verifyNetwork(options.ingressKey,request.headers[NETWORK_PROOF_HEADER],request.url.split("?",1)[0]!) : undefined;
        return options.investigator.investigate(identity.userId,request.params.runId,group);
      }
      const evidence = await investigationStore.evidence(identity.userId,request.params.runId);
      return { status: "UNAVAILABLE",freshModelExecution: false,reason: "AI_NOT_CONFIGURED",retryAt: null,evidence,baseline: deterministicInvestigator(evidence) };
    });
    routes.post<{ Params: { runId: string } }>("/api/scenarios/:runId/diagnostics", { bodyLimit: 4096 }, async (request,reply) => {
      const identity = await sessionIdentity(options.auth,request); if (!identity) return reply.code(401).send({ error: "Session required" });
      const body = z.object({ kind: z.enum(diagnosticKinds) }).strict().safeParse(request.body);
      if (!id.safeParse(request.params.runId).success || !body.success) return reply.code(400).send({ error: "Invalid read-only diagnostic" });
      return investigationStore.diagnostic(identity.userId,request.params.runId,body.data.kind);
    });
  });
}
