import type { Investigation,InvestigationEvidence,DiagnosticKind } from "../../src/ai/investigation.ts";
/** Essential case reads never depend on optional investigation history or write APIs. */
export type Plan = { id: string; plan_sha256: string; keep_order_id: string; void_order_ids_json: string; expires_at: string };
export type Scenario = { run: { id: string; label: string }; orders: Array<{ id: string; effective_status: string; amount_minor: number; currency: string }>;
  paymentReference: { attemptId: string; evidenceSeq: number; observedAt: string; provenance: string; note: string };latestPlan?: Plan & { approved: boolean; has_receipt: boolean };
  latestCheck?: { seq: number; result: string; activeOrderCount: number; evaluatedAt: string; incidentId: string|null }|null };
export type Receipt = { receipt: { execution_id: string; outcome: string; completed_at: string; provider_before_sha256: string; provider_after_sha256: string }; verifiedCurrent: boolean; current: { activeOrders: number; matchingKeeper: number; providerUnchanged: boolean } };
export type ReadApi = <T>(path: string) => Promise<T>;
export type Session = { authenticated: boolean; userId?: string; owner?: boolean };
export type SessionStatus = "UNKNOWN"|"CHECKING"|"AUTHENTICATED"|"SIGNED_OUT";
export type Analysis = { status: "FRESH"|"CACHED"|"UNAVAILABLE"; freshModelExecution?: boolean; reason?: string|null; retryAt?: string|null; generatedAt?: string; model?: string;
  investigation?: Investigation; snapshotSha256?: string; evidence: InvestigationEvidence[]; baseline: { summary: string; nextDiagnostic: DiagnosticKind } };

const object = (v: unknown): v is Record<string,unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown,max = 2000): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const instant = (v: unknown): v is string => text(v,80) && Number.isFinite(Date.parse(v));
const diagnosticKind = (v: unknown) => ["HANDLER_TIMING","IDEMPOTENCY_KEYS","MERCHANT_WRITE_OUTCOMES"].includes(String(v));
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
function validEvidence(e: unknown): e is InvestigationEvidence {
  return object(e) && text(e.id,100) && ["PAYPAL_SANDBOX_OBSERVATION","SYNTHETIC_PAYMENT_OBSERVATION","CONTROLLED_MERCHANT_STATE","MERCHANT_DIAGNOSTIC"].includes(String(e.source))
    && instant(e.observedAt) && object(e.facts) && JSON.stringify(e.facts).length <= 32000;
}
export function parseDiagnostic(value: unknown,expected: DiagnosticKind): InvestigationEvidence {
  if (!diagnosticKind(expected) || !validEvidence(value) || value.source !== "MERCHANT_DIAGNOSTIC" || value.facts.diagnostic !== expected
    || !Array.isArray(value.facts.entries) || value.facts.entries.length > 100
    || (expected === "IDEMPOTENCY_KEYS" && !count(value.facts.distinctKeys))
    || (expected === "MERCHANT_WRITE_OUTCOMES" && !count(value.facts.committedWrites))) throw new Error("Invalid diagnostic response. Recheck the case before requesting another diagnostic; no request was replayed.");
  return value;
}
export function planExpired(plan: Plan,now = Date.now()) { return !instant(plan.expires_at) || Date.parse(plan.expires_at) <= now; }
export const validOperationId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
export type PendingCreation = { operationId: string; userId: string };
export function parsePendingCreation(value: string): PendingCreation|null {
  try { const p: unknown = JSON.parse(value); return object(p) && validOperationId(p.operationId) && text(p.userId,200) ? { operationId: p.operationId,userId: p.userId } : null; } catch { return null; }
}
export function parseCreation(value: unknown,operationId: string): Scenario {
  if (!object(value) || !object(value.creation) || value.creation.operationId !== operationId || value.creation.outcome !== "COMMITTED") throw new Error("Case creation returned invalid data. Recheck this operation before continuing.");
  return parseScenario(value);
}
export function parseOperation(value: unknown,operationId: string): Scenario|null {
  if (!object(value) || value.operationId !== operationId) throw new Error("Creation lookup returned an invalid operation identity. No replacement was created.");
  if (value.outcome === "UNKNOWN" && value.scenario === null) return null;
  if (value.outcome === "COMMITTED") return parseScenario(value.scenario);
  throw new Error("Creation lookup returned an invalid outcome. Recheck the same operation; no request was replayed.");
}
export function detectedFromCase(scenario: Scenario) {
  const check = scenario.latestCheck;
  return !!check && check.result === "VIOLATED" && !!check.incidentId && check.activeOrderCount > 1
    && check.activeOrderCount === scenario.orders.filter(o => o.effective_status === "placed").length;
}
export function aiAvailability(reason?: string|null,retryAt?: string|null) {
  const reasons: Record<string,string> = {
    AI_NOT_CONFIGURED: "AI is not connected for this environment.",BUDGET_DISABLED: "AI requests are disabled for this environment.",
    SESSION_DAILY_BUDGET: "This session has used its daily AI allowance.",APP_DAILY_BUDGET: "Today's shared AI allowance has been used.",
    APP_REQUEST_SPACING: "AI requests are temporarily spaced out. Wait before requesting another analysis.",AI_BUSY: "Another analysis is in progress. Try again later.",
    QUOTA_OR_RATE_LIMIT: "The AI provider has reached its request allowance. Try again later.",TIMEOUT: "The AI provider did not respond within the time limit.",
    NETWORK: "The AI provider could not be reached.",PROVIDER_UNAVAILABLE: "The AI provider is temporarily unavailable.",
    RESERVATION_INTERRUPTED: "The analysis was interrupted; its model usage is uncertain.",CACHED_RESULT_INVALID: "The saved AI response could not be validated."
  };
  return `${reasons[reason ?? ""] ?? "AI analysis is unavailable or could not be validated."}${instant(retryAt) ? ` Retry after ${new Date(retryAt).toLocaleString(undefined,{ timeZoneName: "short" })}.` : ""} You can continue with deterministic findings and merchant diagnostics.`;
}

/** Validate only the UI contract; this does not certify AI claims or citations. */
export function validateHistory(value: unknown): asserts value is Analysis|null {
  if (value === null) return;
  const invalid = () => new Error("AI response returned invalid data. The last validated analysis is preserved; recheck the case before continuing.");
  if (!object(value) || !["FRESH","CACHED","UNAVAILABLE"].includes(String(value.status)) || !Array.isArray(value.evidence) || value.evidence.length > 120
    || !value.evidence.every(validEvidence) || new Set(value.evidence.map(e => e.id)).size !== value.evidence.length || !object(value.baseline)
    || !text(value.baseline.summary) || !diagnosticKind(value.baseline.nextDiagnostic)
    || (value.status === "FRESH" && (value.freshModelExecution !== true || !value.investigation || !instant(value.generatedAt)))
    || (value.status !== "FRESH" && value.freshModelExecution !== undefined && value.freshModelExecution !== false)
    || (value.status === "UNAVAILABLE" && value.investigation !== undefined)
    || (value.reason !== undefined && value.reason !== null && !text(value.reason,100))
    || (value.retryAt !== undefined && value.retryAt !== null && !instant(value.retryAt))
    || (value.generatedAt !== undefined && !instant(value.generatedAt))
    || (value.model !== undefined && !text(value.model,150))
    || (value.snapshotSha256 !== undefined && !/^[a-f0-9]{64}$/.test(String(value.snapshotSha256)))) throw invalid();
  for (const e of value.evidence) if (e.source === "MERCHANT_DIAGNOSTIC") parseDiagnostic(e,e.facts.diagnostic as DiagnosticKind);
  if (value.investigation !== undefined) {
    const investigation = value.investigation;
    const ids = new Set(value.evidence.map(e => e.id));
    if (!object(investigation) || !text(investigation.summary,600) || !text(investigation.diagnosticReason,250)
      || !diagnosticKind(investigation.nextDiagnostic) || !Array.isArray(investigation.hypotheses) || investigation.hypotheses.length < 1 || investigation.hypotheses.length > 4
      || !investigation.hypotheses.every(h => object(h) && ["LOW","MEDIUM","HIGH"].includes(String(h.confidence)) && h.status === "HYPOTHESIS" && text(h.explanation,500)
        && Array.isArray(h.evidenceIds) && h.evidenceIds.length > 0 && h.evidenceIds.length <= 10 && h.evidenceIds.every(id => text(id,80) && ids.has(id)))) throw invalid();
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
    || ![scenario.paymentReference.observedAt,scenario.paymentReference.provenance,scenario.paymentReference.note].every(v => typeof v === "string")
    || !instant(scenario.paymentReference.observedAt) || !["PAYPAL_SANDBOX_GET","SYNTHETIC_QUALIFICATION"].includes(scenario.paymentReference.provenance)) throw invalid();
  const plan = scenario.latestPlan ?? null;
  const check = scenario.latestCheck;
  if (check !== undefined && check !== null && (!object(check) || !Number.isSafeInteger(check.seq) || check.seq < 1
    || !["HOLDS","VIOLATED","NOT_ELIGIBLE","OUT_OF_SCOPE"].includes(check.result)
    || !count(check.activeOrderCount) || !instant(check.evaluatedAt) || !(check.incidentId === null || text(check.incidentId,100)))) throw invalid();
  if (plan !== null && (typeof plan !== "object" || Array.isArray(plan))) throw invalid();
  if (plan) {
    if (![plan.id,plan.plan_sha256,plan.keep_order_id,plan.void_order_ids_json,plan.expires_at].every(v => typeof v === "string") || !instant(plan.expires_at) || typeof plan.approved !== "boolean" || typeof plan.has_receipt !== "boolean") throw invalid();
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
    || !instant(receipt.receipt.completed_at) || !count(receipt.current.activeOrders) || !count(receipt.current.matchingKeeper) || typeof receipt.current.providerUnchanged !== "boolean"
    || (receipt.verifiedCurrent && (receipt.receipt.outcome !== "SUCCEEDED" || receipt.current.activeOrders !== 1 || receipt.current.matchingKeeper !== 1 || !receipt.current.providerUnchanged
      || receipt.receipt.provider_before_sha256 !== receipt.receipt.provider_after_sha256)))) throw new Error("Case receipt returned an invalid response. Resume/Recheck Case.");
  return { scenario, plan, receipt };
}
