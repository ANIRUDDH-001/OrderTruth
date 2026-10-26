/** Essential case reads never depend on optional investigation history or write APIs. */
export type Plan = { id: string; plan_sha256: string; keep_order_id: string; void_order_ids_json: string; expires_at: string };
export type Scenario = { run: { id: string; label: string }; orders: Array<{ id: string; effective_status: string; amount_minor: number; currency: string }>;
  paymentReference: { attemptId: string; evidenceSeq: number; observedAt: string; provenance: string; note: string };latestPlan?: Plan & { approved: boolean; has_receipt: boolean } };
export type Receipt = { receipt: { execution_id: string; outcome: string; completed_at: string; provider_before_sha256: string; provider_after_sha256: string }; verifiedCurrent: boolean; current: { activeOrders: number; matchingKeeper: number; providerUnchanged: boolean } };
export type ReadApi = <T>(path: string) => Promise<T>;
export type Session = { authenticated: boolean; userId?: string; owner?: boolean };
export type SessionStatus = "UNKNOWN"|"CHECKING"|"AUTHENTICATED"|"SIGNED_OUT";

/** Validate only the UI contract; this does not certify AI claims or citations. */
export function validateHistory(value: unknown): void {
  if (value === null) return;
  const record = (v: unknown): v is Record<string,unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const diagnostic = (v: unknown) => ["HANDLER_TIMING","IDEMPOTENCY_KEYS","MERCHANT_WRITE_OUTCOMES"].includes(String(v));
  const invalid = () => new Error("Saved AI history returned invalid data");
  if (!record(value) || !["FRESH","CACHED","UNAVAILABLE"].includes(String(value.status)) || !Array.isArray(value.evidence)
    || !value.evidence.every(e => record(e) && typeof e.source === "string" && typeof e.id === "string" && record(e.facts)) || !record(value.baseline)
    || typeof value.baseline.summary !== "string" || !diagnostic(value.baseline.nextDiagnostic)) throw invalid();
  if (value.investigation !== undefined) {
    const investigation = value.investigation;
    if (!record(investigation) || typeof investigation.summary !== "string" || typeof investigation.diagnosticReason !== "string"
      || !diagnostic(investigation.nextDiagnostic) || !Array.isArray(investigation.hypotheses)
      || !investigation.hypotheses.every(h => record(h) && typeof h.confidence === "string" && typeof h.explanation === "string"
        && Array.isArray(h.evidenceIds) && h.evidenceIds.every(id => typeof id === "string"))) throw invalid();
  }
}

export async function readSession(api: ReadApi): Promise<Session> {
  const session = await api<Session>("/api/session");
  if (!session || typeof session.authenticated !== "boolean" || (session.authenticated && (typeof session.userId !== "string" || session.userId.length === 0))) {
    throw new Error("Session discovery returned an invalid response. Recheck session access; no new identity was created.");
  }
  return session;
}

export function parseScenario(value: unknown,expectedRunId?: string): Scenario {
  const scenario = value as Scenario|null;
  const invalid = () => new Error("Case recovery returned an invalid response. Resume/Recheck Case; no replacement action was sent.");
  if (!scenario || typeof scenario.run?.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(scenario.run.id)
    || (expectedRunId !== undefined && scenario.run.id !== expectedRunId) || typeof scenario.run.label !== "string" || !Array.isArray(scenario.orders)
    || scenario.orders.some(o => !o || typeof o.id !== "string" || typeof o.effective_status !== "string" || !Number.isSafeInteger(o.amount_minor) || typeof o.currency !== "string")
    || !scenario.paymentReference || typeof scenario.paymentReference.attemptId !== "string" || !Number.isSafeInteger(scenario.paymentReference.evidenceSeq)
    || ![scenario.paymentReference.observedAt,scenario.paymentReference.provenance,scenario.paymentReference.note].every(v => typeof v === "string")) throw invalid();
  const plan = scenario.latestPlan ?? null;
  if (plan !== null && (typeof plan !== "object" || Array.isArray(plan))) throw invalid();
  if (plan) {
    if (![plan.id,plan.plan_sha256,plan.keep_order_id,plan.void_order_ids_json,plan.expires_at].every(v => typeof v === "string") || typeof plan.approved !== "boolean" || typeof plan.has_receipt !== "boolean") throw invalid();
    let voids: unknown; try { voids = JSON.parse(plan.void_order_ids_json); } catch { throw invalid(); }
    if (!Array.isArray(voids) || !voids.every(v => typeof v === "string")) throw invalid();
  }
  return scenario;
}

export async function readCase(api: ReadApi, runId: string) {
  const base = `/api/scenarios/${encodeURIComponent(runId)}`;
  const scenario = parseScenario(await api<unknown>(base),runId);
  const plan = scenario.latestPlan ?? null;
  const receipt = plan?.has_receipt ? await api<Receipt>(`${base}/receipts/${encodeURIComponent(plan.id)}`) : null;
  if (plan?.has_receipt && (!receipt || typeof receipt.verifiedCurrent !== "boolean" || !receipt.receipt || !receipt.current
    || ![receipt.receipt.execution_id,receipt.receipt.outcome,receipt.receipt.completed_at,receipt.receipt.provider_before_sha256,receipt.receipt.provider_after_sha256].every(v => typeof v === "string")
    || !Number.isSafeInteger(receipt.current.activeOrders) || !Number.isSafeInteger(receipt.current.matchingKeeper) || typeof receipt.current.providerUnchanged !== "boolean"
    || (receipt.verifiedCurrent && (receipt.receipt.outcome !== "SUCCEEDED" || receipt.current.activeOrders !== 1 || receipt.current.matchingKeeper !== 1 || !receipt.current.providerUnchanged)))) throw new Error("Case receipt returned an invalid response. Resume/Recheck Case.");
  return { scenario, plan, receipt };
}
