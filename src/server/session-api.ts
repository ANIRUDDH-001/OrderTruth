import type { FastifyInstance, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import type { createSessionAuth } from "./auth.ts";

type SessionAuth = ReturnType<typeof createSessionAuth>;
export async function sessionIdentity(auth: SessionAuth, request: FastifyRequest, ownerIds: ReadonlySet<string> = new Set()) {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) return null;
  return { userId: session.user.id,anonymous: session.user.isAnonymous === true,authenticatedAtMs: new Date(session.session.createdAt).getTime(),
    owner: session.user.isAnonymous !== true && ownerIds.has(session.user.id) };
}
/** No identity headers, no public sign-up, no CORS wildcard. Proxy identity must
 * be configured explicitly on Fastify before trusting request.ip in deployment. */
export function registerSessionApi(app: FastifyInstance, auth: SessionAuth, origin: string, ownerIds: ReadonlySet<string> = new Set()) {
  app.get("/api/session", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const identity = await sessionIdentity(auth, request, ownerIds);
    return identity ? { authenticated: true, ...identity } : { authenticated: false };
  });
  for (const path of ["sign-in/anonymous", "sign-in/email", "sign-out"]) app.post(`/api/auth/${path}`, { bodyLimit: 16_384 }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (request.headers.origin !== origin) return reply.code(403).send({ error: "Same-origin request required" });
    const headers = fromNodeHeaders(request.headers);
    // Overwrite rather than trusting this client-supplied header. Better Auth
    // persists its rate-limit counters in PostgreSQL across restarts.
    headers.set("x-ordertruth-client-ip", request.ip);
    try {
      const response = await auth.handler(new Request(`${origin}/api/auth/${path}`, {
        method: "POST", headers, body: JSON.stringify(request.body ?? {}),
      }));
      reply.code(response.status);
      for (const [key, value] of response.headers) if (key !== "set-cookie") reply.header(key, value);
      const cookies = response.headers.getSetCookie(); if (cookies.length) reply.header("set-cookie", cookies);
      // Sign-in endpoints normally return a bearer token as well as an HttpOnly
      // cookie. This app needs only the cookie, so no token reaches app JS.
      const payload = await response.json() as Record<string, unknown>;
      if (response.ok) return { ok: true };
      return { error: typeof payload.code === "string" ? payload.code : "Authentication unavailable" };
    } catch { return reply.code(503).send({ error: "Authentication unavailable" }); }
  });
}
