import { afterEach,describe,expect,it,vi } from "vitest";
import { mountJudge,scenario } from "./helpers/judge-dom.ts";
const session = { authenticated: true,userId: "fixture_user",owner: false };
const operationId = "12345678-1234-4234-8234-123456789abc";
const marker = "ordertruth.judge.unidentifiedCreation";
afterEach(async () => { if (vi.isFakeTimers()) await vi.runAllTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });
describe("durable creation recovery UI",() => {
  it("persists a UUID before POST and reconciles commit-after-response-loss with GET only",async () => {
    const storage = new Map<string,string>();let id = "";
    const ui = await mountJudge((c,body) => {
      if (c.path === "/api/session") return session;
      if (c.path === "/api/scenarios") { id = (body as { operationId: string }).operationId; expect(JSON.parse(storage.get(marker)!).operationId).toBe(id);throw new TypeError("Response lost"); }
      if (c.path.startsWith("/api/scenario-operations/")) return { operationId: id,outcome: "COMMITTED",scenario: scenario("run_committed") };
      if (c.path.endsWith("/investigation")) return null;
      return scenario("run_committed");
    },"",storage);
    await ui.click("Inspect a payment outcome");expect(id).toMatch(/^[a-f0-9-]{36}$/);expect(storage.has(marker)).toBe(true);
    expect(ui.doc.root.textContent).toContain("Recover the previous request first");
    const mark = ui.calls.length;await ui.click("Resume/Recheck Case");
    expect(ui.calls.slice(mark).every(c => c.method === "GET")).toBe(true);expect(ui.location.href).toContain("run_committed");expect(storage.has(marker)).toBe(false);
    expect(ui.calls.filter(c => c.path === "/api/scenarios")).toHaveLength(1);
  });
  it("keeps UNKNOWN locked across reload and retries only the same identity after a read",async () => {
    const storage = new Map([[marker,JSON.stringify({ operationId,userId: session.userId })]]);
    let posts = 0;
    const ui = await mountJudge((c,body) => {
      if (c.path === "/api/session") return session;
      if (c.path.startsWith("/api/scenario-operations/")) return { operationId,outcome: "UNKNOWN",scenario: null };
      if (c.path === "/api/scenarios") { posts++;expect(body).toEqual({ operationId });return { ...scenario("run_owned"),creation: { operationId,outcome: "COMMITTED" } }; }
      if (c.path.endsWith("/investigation")) return null;
      return scenario("run_owned");
    },"",storage);
    expect(posts).toBe(0);expect(ui.button("Inspect a payment outcome").disabled).toBe(true);
    await ui.click("Retry same case creation");expect(posts).toBe(1);expect(storage.has(marker)).toBe(false);
    const beforePost = ui.calls.findIndex(c => c.method === "POST");expect(ui.calls.slice(0,beforePost).some(c => c.path === `/api/scenario-operations/${operationId}`)).toBe(true);
  });
  it("never replays a pending creation under a different authenticated owner",async () => {
    const storage = new Map([[marker,JSON.stringify({ operationId,userId: "other_owner" })]]);
    const ui = await mountJudge(() => session,"",storage);
    expect(ui.doc.root.textContent).toMatch(/original session/i);
    expect(ui.calls.filter(c => c.method === "POST" || c.path.includes("scenario-operations"))).toHaveLength(0);
    expect(ui.button("Retry same case creation").disabled).toBe(true);
  });
  it("restores detection from persisted explicit check without a plan or AI",async () => {
    const s = scenario("run_owned");s.orders.push({ ...s.orders[0]!,id: "duplicate" });
    const ui = await mountJudge(c => c.path === "/api/session" ? session : c.path.endsWith("/investigation") ? null : { ...s,latestCheck: { seq: 7,result: "VIOLATED",activeOrderCount: 2,evaluatedAt: "2026-11-07T00:00:00Z",incidentId: "incident" } },"run_owned");
    expect(ui.button("Review exact repair plan").disabled).toBe(false);expect(ui.doc.root.textContent).toContain("DetectComplete");expect(ui.calls.every(c => c.method === "GET")).toBe(true);
  });
  it("does not restore stale HOLDS or mismatched-count checks as a discrepancy",async () => {
    const s = scenario("run_owned");s.orders.push({ ...s.orders[0]!,id: "duplicate" });
    const ui = await mountJudge(c => c.path === "/api/session" ? session : c.path.endsWith("/investigation") ? null : { ...s,latestCheck: { seq: 8,result: "HOLDS",activeOrderCount: 1,evaluatedAt: "2026-11-07T00:00:00Z",incidentId: null } },"run_owned");
    expect(ui.doc.root.querySelectorAll("button").some(b => b.textContent === "Review exact repair plan")).toBe(false);
  });
  it("does not let a fresh check response override contradictory persisted progress",async () => {
    const s = scenario("run_owned");s.orders.push({ ...s.orders[0]!,id: "duplicate" });
    const ui = await mountJudge(c => c.path === "/api/session" ? session : c.path.endsWith("/investigation") ? null : c.path.endsWith("/check") ? { result: "VIOLATED" } : { ...s,latestCheck: { seq: 8,result: "HOLDS",activeOrderCount: 1,evaluatedAt: "2026-11-07T00:00:00Z",incidentId: null } },"run_owned");
    await ui.click("Detect anomaly");expect(ui.doc.root.querySelectorAll("button").some(b => b.textContent === "Review exact repair plan")).toBe(false);
  });
});
