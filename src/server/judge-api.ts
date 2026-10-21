import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { createSessionAuth } from "./auth.ts";
import { sessionIdentity } from "./session-api.ts";
import { PostgresScenarioStore } from "../merchant/postgres-scenarios.ts";
import { PostgresRecoveryService } from "../merchant/postgres-recovery.ts";
import { PostgresInvestigationStore } from "../ai/postgres-investigation.ts";
import type { PostgresInvestigationService } from "../ai/postgres-investigation-service.ts";
import { diagnosticKinds,deterministicInvestigator } from "../ai/investigation.ts";
import { admitDemoAction } from "./demo-limits.ts";

/** Public judge routes never receive a payment provider or a model that can
 * mutate money. Identity and run ownership come from persisted sessions. */
export function registerJudgeApi(app: FastifyInstance, options: {
  pool: Pool; schema: string; auth: ReturnType<typeof createSessionAuth>; origin: string; sourceAttemptId: string | null; investigator?: PostgresInvestigationService;
}) {
  const scenarios = new PostgresScenarioStore(options.pool,options.schema);
  const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
  const empty = z.object({}).strict();
  const planBody = z.object({ planId: id }).strict();
  const approvalBody = z.object({ planId: id,planSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
  const investigationStore = new PostgresInvestigationStore(options.pool,options.schema);
  app.register(async routes => {
    routes.addHook("onRequest", async (request,reply) => {
      reply.header("cache-control","no-store");
      if (request.method === "POST" && request.headers.origin !== options.origin) return reply.code(403).send({ error: "Same-origin request required" });
    });
    routes.setErrorHandler((error,_request,reply) => {
      const message = error instanceof Error ? error.message : "";
      if (/not found/i.test(message)) return reply.code(404).send({ error: "Scenario not found" });
      if (/hash|expired|stale|eligible|identity differs/i.test(message)) return reply.code(409).send({ error: "Case changed; recheck before approval" });
      if (/admission limit/i.test(message)) return reply.code(429).send({ error: "Scenario capacity reached; existing receipts remain available" });
      return reply.code(503).send({ error: "Scenario unavailable; committed evidence and receipts are preserved" });
    });
    routes.post("/api/scenarios", { bodyLimit: 4096 }, async (request,reply) => {
      const identity = await sessionIdentity(options.auth,request); if (!identity) return reply.code(401).send({ error: "Start a judge session first" });
      if (!empty.safeParse(request.body).success) return reply.code(400).send({ error: "Scenario creation accepts no payment or price overrides" });
      const source = options.sourceAttemptId ?? (await options.pool.query(`SELECT a.id FROM ${options.schema}.payment_attempts a
        JOIN ${options.schema}.evidence e ON e.attempt_id=a.id WHERE a.state='captured' AND e.evidence_class='PAYPAL_API_READBACK'
        AND e.http_status=200 AND e.summary_json::jsonb->>'provenance'='PAYPAL_SANDBOX_GET' ORDER BY e.seq DESC LIMIT 1`)).rows[0]?.id as string | undefined;
      if (!source) return reply.code(503).send({ error: "An owner-approved Sandbox observation is not available yet" });
      const run = await scenarios.create(identity.userId,source);
      return scenarios.get(identity.userId,run.id);
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
      await scenarios.get(identity.userId,request.params.runId);
      return options.investigator ? options.investigator.history(identity.userId,request.params.runId) : null;
    });
    routes.post<{ Params: { runId: string } }>("/api/scenarios/:runId/investigate", { bodyLimit: 4096 }, async (request,reply) => {
      const identity = await sessionIdentity(options.auth,request); if (!identity) return reply.code(401).send({ error: "Session required" });
      if (!id.safeParse(request.params.runId).success || !empty.safeParse(request.body).success) return reply.code(400).send({ error: "Invalid investigation" });
      if (options.investigator) return options.investigator.investigate(identity.userId,request.params.runId);
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
