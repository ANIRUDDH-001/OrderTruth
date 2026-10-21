import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PostgresRecoveryService } from "./postgres-recovery.ts";

export type RecoveryScope = { organizationId: string; actorId: string };
/** Session ownership and approval are required adapters, with no header-based default.
 * These routes are not mounted by the legacy runtime during migration. */
export function registerPostgresRecoveryApi(app: FastifyInstance, service: PostgresRecoveryService, options: {
  resolveScope(request: FastifyRequest): Promise<RecoveryScope | null>;
  approve(scope: RecoveryScope, plan: string, hash: string): Promise<void>;
}) {
  if (!options.resolveScope || !options.approve) throw new Error("Recovery requires authenticated scope and approval adapters");
  app.register(async routes => {
  const app = routes;
  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : "";
    if (/not found for scope/i.test(message)) return reply.code(404).send({ error: "Case not found" });
    if (/exact plan hash|stale|expired|not eligible|identity differs/i.test(message)) return reply.code(409).send({ error: "Case or approval changed; recheck the current plan" });
    return reply.code(503).send({ error: "Investigation service unavailable; your committed case is preserved" });
  });
  const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
  const checkBody = z.object({ intentId: id }).strict();
  const planBody = z.object({ incidentId: id }).strict();
  const approvalBody = z.object({ planId: id, planSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
  const executionBody = z.object({ planId: id }).strict();
  app.post("/api/recovery/check", async (request, reply) => {
    const scope = await options.resolveScope(request); if (!scope) return reply.code(401).send({ error: "Sign in required" });
    const body = checkBody.safeParse(request.body); if (!body.success) return reply.code(400).send({ error: "Invalid case request" });
    return service.check(scope.organizationId, body.data.intentId);
  });
  app.post("/api/recovery/plan", async (request, reply) => {
    const scope = await options.resolveScope(request); if (!scope) return reply.code(401).send({ error: "Sign in required" });
    const body = planBody.safeParse(request.body); if (!body.success) return reply.code(400).send({ error: "Invalid plan request" });
    return service.plan(scope.organizationId, body.data.incidentId, scope.actorId);
  });
  app.post("/api/recovery/approve", async (request, reply) => {
    const scope = await options.resolveScope(request); if (!scope) return reply.code(401).send({ error: "Sign in required" });
    const body = approvalBody.safeParse(request.body); if (!body.success) return reply.code(400).send({ error: "Exact plan and hash required" });
    await options.approve(scope, body.data.planId, body.data.planSha256);
    return { approved: true, planId: body.data.planId, planSha256: body.data.planSha256 };
  });
  app.post("/api/recovery/execute", async (request, reply) => {
    const scope = await options.resolveScope(request); if (!scope) return reply.code(401).send({ error: "Sign in required" });
    const body = executionBody.safeParse(request.body); if (!body.success) return reply.code(400).send({ error: "Invalid repair request" });
    return service.execute(scope.organizationId, body.data.planId);
  });
  app.get<{ Params: { id: string } }>("/api/recovery/receipts/:id", async (request, reply) => {
    const scope = await options.resolveScope(request); if (!scope) return reply.code(401).send({ error: "Sign in required" });
    if (!id.safeParse(request.params.id).success) return reply.code(400).send({ error: "Invalid receipt request" });
    return service.verify(scope.organizationId, request.params.id);
  });
  });
}
