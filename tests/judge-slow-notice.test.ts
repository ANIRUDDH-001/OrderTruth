import { afterEach,describe,expect,it,vi } from "vitest";
import { mountJudge,scenario,type UiCall } from "./helpers/judge-dom.ts";

afterEach(async () => { if (vi.isFakeTimers()) await vi.runAllTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

const session = { authenticated: true,userId: "fixture_owner",owner: false };
const plan = { id: "rp_fixture",plan_sha256: "fixture_hash",keep_order_id: "keeper",void_order_ids_json: '["duplicate"]',expires_at: "2026-10-26T00:00:00Z",approved: true,has_receipt: true };
const receipt = { receipt: { execution_id: "execution_fixture",outcome: "SUCCEEDED",completed_at: "2026-10-26T00:00:00Z",provider_before_sha256: "unchanged",provider_after_sha256: "unchanged" },
  verifiedCurrent: true,current: { activeOrders: 1,matchingKeeper: 1,providerUnchanged: true } };
const READ = "Still working (45 s). The server may be waking from idle or busy. This step only reads saved records; it does not submit or repeat a payment or repair action.";
const WRITE = (s: number) => `Still working (${s} s). The server may be waking from idle or busy. Waiting is bounded. If this is interrupted, the action may still have committed; use Resume/Recheck Case before acting again.`;

// Holds every matching request until released, so fake time can pass while it is pending.
function gate(match: (call: UiCall) => boolean) {
  let open: () => void = () => {}; let held = false;
  const barrier = new Promise<void>(resolve => { open = resolve; });
  return { hold() { held = true; },release() { open(); },async wait(call: UiCall) { if (held && match(call)) await barrier; } };
}
const status = (ui: Awaited<ReturnType<typeof mountJudge>>) => ui.doc.querySelector("p.notice[role=status]");
const writes = (calls: UiCall[]) => calls.filter(c => c.method !== "GET");

describe("slow-request notice on the judge page",() => {
  it("shows the read-only notice during a slow first load, without rebuilding, moving focus or sending a write",async () => {
    const slow = gate(c => c.path === "/api/session"); slow.hold();
    const ui = await mountJudge(async call => {
      await slow.wait(call);
      if (call.path === "/api/session") return session;
      if (call.path.endsWith("/investigation")) return null;
      return scenario("run_owned");
    },"run_owned",undefined,{ settle: false });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(status(ui)?.textContent).toBe("Loading your session…");
    await vi.advanceTimersByTimeAsync(45_000-1_999);
    const notice = status(ui)!;
    expect(notice.textContent).toBe(`Loading your session… ${READ}`);
    expect(notice.getAttribute("aria-live")).toBe("polite");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(status(ui)).toBe(notice);
    expect(ui.doc.activeElement).toBeNull();
    slow.release(); await ui.idle();
    expect(ui.calls.length).toBeGreaterThan(1);
    expect(writes(ui.calls)).toEqual([]);
  });

  for (const action of ["Resume/Recheck Case","Recheck committed receipt"]) it(`shows the read-only notice for a slow ${action} and sends only GET requests`,async () => {
    const slow = gate(c => c.path === "/api/session");
    const ui = await mountJudge(async call => {
      await slow.wait(call);
      if (call.path === "/api/session") return session;
      if (call.path.endsWith("/investigation")) return null;
      if (call.path.includes("/receipts/")) return receipt;
      return { ...scenario("run_owned"),latestPlan: plan };
    },"run_owned");
    const mark = ui.calls.length; slow.hold();
    ui.button(action).fire("click");
    await vi.advanceTimersByTimeAsync(0);
    const notice = status(ui)!,focused = ui.doc.activeElement;
    await vi.advanceTimersByTimeAsync(45_000);
    expect(status(ui)).toBe(notice);
    expect(notice.textContent).toBe(`${action}… ${READ}`);
    expect(ui.doc.activeElement).toBe(focused);
    slow.release(); await ui.idle();
    expect(ui.calls.length).toBeGreaterThan(mark);
    expect(writes(ui.calls.slice(mark))).toEqual([]);
  });

  it("keeps the committed-action warning for a slow write and never replays it after the wait limit",async () => {
    const slow = gate(c => c.path.endsWith("/duplicate"));
    const ui = await mountJudge(async call => {
      await slow.wait(call);
      if (call.path === "/api/session") return session;
      if (call.path.endsWith("/investigation")) return null;
      return scenario("run_owned");
    },"run_owned");
    slow.hold();
    ui.button("Introduce duplicate").fire("click");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(status(ui)?.textContent).toBe(`Introduce duplicate… ${WRITE(30)}`);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ui.doc.root.textContent).toMatch(/may have committed/);
    expect(writes(ui.calls).map(c => c.path)).toEqual(["/api/scenarios/run_owned/duplicate"]);
    slow.release();
  });
});
