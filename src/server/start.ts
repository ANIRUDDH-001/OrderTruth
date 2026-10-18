import type { FastifyInstance } from "fastify";
import type { CheckoutService, Logger, ReconcileOutcome } from "../checkout-service.ts";

/**
 * Start sequence shared by the real server and the process tests: settle unfinished payments by
 * readback first (crash recovery), then listen, then keep reconciling on an interval.
 * The reconciler only ever issues GET requests.
 */
export async function startServer(o: {
  app: FastifyInstance;
  checkout: CheckoutService;
  log: Logger;
  host: string;
  port: number;
  /** 0 disables the periodic reconciler. */
  reconcileIntervalMs: number;
}): Promise<{ port: number; startupReconcile: { outcomes: ReconcileOutcome[] }; stop: () => void }> {
  const startupReconcile = await o.checkout.reconcile(`startup_reconcile_${process.pid}`);
  o.log.info({ evt: "startup_reconcile", outcomes: startupReconcile.outcomes.length, open: startupReconcile.outcomes.filter((x) => x.to !== "captured" && x.to !== "denied" && x.to !== "mismatch").length });
  await o.app.listen({ host: o.host, port: o.port });
  const addr = o.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : o.port;
  let timer: NodeJS.Timeout | null = null;
  if (o.reconcileIntervalMs > 0) {
    timer = setInterval(() => {
      o.checkout.reconcile().catch((err: unknown) => o.log.warn({ evt: "reconcile_interval_failed", errName: (err as Error)?.name }));
    }, o.reconcileIntervalMs);
    timer.unref();
  }
  return { port, startupReconcile, stop: () => timer && clearInterval(timer) };
}
