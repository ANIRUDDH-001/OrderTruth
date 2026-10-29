import { describe,expect,it } from "vitest";
import { readCase,readSession,parseScenario,validateHistory,type ReadApi } from "../web/judge/recovery.ts";

function fixture(latestPlan: unknown) {
  const calls: string[] = [];
  const receipt = { verifiedCurrent: true,receipt: { execution_id: "execution",outcome: "SUCCEEDED",completed_at: "2026-10-26T00:00:00Z",provider_before_sha256: "hash",provider_after_sha256: "hash" },current: { activeOrders: 1,matchingKeeper: 1,providerUnchanged: true } };
  const scenario = { run: { id: "run_owned",label: "controlled" },orders: [],paymentReference: { attemptId: "synthetic",evidenceSeq: 1,observedAt: "2026-10-26T00:00:00Z",provenance: "SYNTHETIC_QUALIFICATION",note: "synthetic" },latestPlan: latestPlan ? { plan_sha256: "hash",keep_order_id: "order",void_order_ids_json: "[]",expires_at: "2026-10-26T00:15:00Z",approved: false,...latestPlan as object } : null };
  const api: ReadApi = async <T>(path: string) => {
    calls.push(path);
    if (path.includes("/investigation")) return new Promise<T>(() => {});
    return (path.includes("/receipts/") ? receipt : scenario) as T;
  };
  return { calls,receipt,scenario,api };
}
describe("essential read-only case restoration",() => {
  it("restores the committed receipt without requesting optional history or mutation",async () => {
    const f = fixture({ id: "plan_owned",approved: true,has_receipt: true });
    const restored = await readCase(f.api,"run_owned");
    expect(restored.scenario).toBe(f.scenario); expect(restored.receipt).toBe(f.receipt);
    expect(f.calls).toEqual(["/api/scenarios/run_owned","/api/scenarios/run_owned/receipts/plan_owned"]);
  });
  it("restores an approved plan with no receipt without trying to execute it",async () => {
    const f = fixture({ id: "plan_owned",approved: true,has_receipt: false });
    expect((await readCase(f.api,"run_owned")).receipt).toBeNull(); expect(f.calls).toHaveLength(1);
  });
  it("clears plan and receipt when persisted state has neither",async () => {
    const f = fixture(null); const restored = await readCase(f.api,"run_owned");
    expect(restored.plan).toBeNull(); expect(restored.receipt).toBeNull(); expect(f.calls).toHaveLength(1);
  });
  it("does not treat a failed receipt read as absence or successful recovery",async () => {
    const f = fixture({ id: "plan_owned",has_receipt: true });
    const api: ReadApi = async <T>(path: string) => { if (path.includes("/receipts/")) throw new Error("read unavailable"); return f.scenario as T; };
    await expect(readCase(api,"run_owned")).rejects.toThrow("read unavailable");
  });
  it("can reconcile a committed result when all mutation requests would be denied",async () => {
    const f = fixture({ id: "plan_owned",approved: true,has_receipt: true });
    const restored = await readCase(f.api,"run_owned");
    expect(restored.receipt).toEqual(f.receipt); expect(f.calls.every(p => !p.endsWith("/execute") && !p.endsWith("/approve"))).toBe(true);
  });
  it("propagates ownership refusal without trying to replace the case",async () => {
    const calls: string[] = [];
    const api: ReadApi = async p => { calls.push(p); throw new Error("Scenario not found"); };
    await expect(readCase(api,"foreign_run")).rejects.toThrow("not found"); expect(calls).toEqual(["/api/scenarios/foreign_run"]);
  });
  it("rejects malformed successful case data before it can become UI state",async () => {
    const api: ReadApi = async <T>() => ({}) as T;
    await expect(readCase(api,"run_owned")).rejects.toThrow("invalid response");
  });
  it("rejects a contradictory success receipt instead of displaying a false recovery",async () => {
    const f = fixture({ id: "plan_owned",has_receipt: true }); f.receipt.current.activeOrders = 2;
    await expect(readCase(f.api,"run_owned")).rejects.toThrow("invalid response");
  });
});
describe("optional saved-history contract",() => {
  it("accepts absence and cached history without requiring new inference",() => {
    expect(() => validateHistory(null)).not.toThrow();
    expect(() => validateHistory({ status: "CACHED",evidence: [],baseline: { summary: "Stored result",nextDiagnostic: "HANDLER_TIMING" } })).not.toThrow();
  });
  it("rejects malformed history before it can replace valid UI state",() => {
    for (const value of [{},{ status: "CACHED",evidence: [] },{ status: "CACHED",evidence: [{ source: "MERCHANT_DIAGNOSTIC" }],baseline: { summary: "Stored",nextDiagnostic: "HANDLER_TIMING" } },{ status: "CACHED",evidence: [],baseline: { summary: "Stored",nextDiagnostic: "HANDLER_TIMING" },investigation: { hypotheses: [null] } }]) {
      expect(() => validateHistory(value)).toThrow("invalid data");
    }
  });
});
describe("creation scenario validation",() => {
  for (const field of ["run.id","run.label","orders.0.id","orders.0.amount_minor","paymentReference.attemptId","paymentReference.evidenceSeq","paymentReference.observedAt","paymentReference.provenance","paymentReference.note"]) {
    it(`rejects a creation missing ${field}`,() => {
      const value = { ...fixture(null).scenario,orders: [{ id: "order",effective_status: "placed",amount_minor: 100,currency: "USD" }] };
      const copy = JSON.parse(JSON.stringify(value)) as Record<string,unknown>;
      const keys = field.split(".");let parent = copy;for (const key of keys.slice(0,-1)) parent = parent[key] as Record<string,unknown>;delete parent[keys.at(-1)!];
      expect(() => parseScenario(copy)).toThrow("invalid response");
    });
  }
  it("rejects invalid run identities and non-object plans before assignment",() => {
    for (const value of [{ ...fixture(null).scenario,run: { id: "../foreign",label: "controlled" } },{ ...fixture(null).scenario,latestPlan: false }]) expect(() => parseScenario(value)).toThrow("invalid response");
  });
});
describe("read-only session discovery",() => {
  it("discovers the existing identity with exactly one read",async () => {
    const calls: string[] = [];
    const api: ReadApi = async <T>(p: string) => { calls.push(p); return { authenticated: true,userId: "original_user" } as T; };
    expect((await readSession(api)).userId).toBe("original_user"); expect(calls).toEqual(["/api/session"]);
  });
  it("accepts confirmed sign-out without creating an identity",async () => {
    const api: ReadApi = async <T>() => ({ authenticated: false }) as T;
    expect((await readSession(api)).authenticated).toBe(false);
  });
  for (const value of [null,{}, { authenticated: true },{ authenticated: true,userId: "" },{ authenticated: "false" }]) {
    it(`rejects malformed discovery ${JSON.stringify(value)} instead of treating it as signed out`,async () => {
      const api: ReadApi = async <T>() => value as T;
      await expect(readSession(api)).rejects.toThrow("invalid response");
    });
  }
  it("propagates unavailable discovery without invoking another endpoint",async () => {
    const calls: string[] = [];
    const api: ReadApi = async p => { calls.push(p); throw new Error("unavailable"); };
    await expect(readSession(api)).rejects.toThrow("unavailable"); expect(calls).toEqual(["/api/session"]);
  });
});
