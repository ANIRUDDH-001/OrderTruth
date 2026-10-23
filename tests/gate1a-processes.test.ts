// MOCKED provider, REAL processes: independent OS processes (each its own Node runtime, SQLite
// connection and in-memory state) share one SQLite file and one HTTP-served FakePayPal.
// Crashes are forced process kills, not exceptions. Never touches the Sandbox.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { capturePosts, FakePayPal, newCheckoutKey } from "./fake-paypal.ts";
import { serveFakePayPal } from "./helpers/fake-paypal-http.ts";

const HARNESS = resolve("tests/helpers/server-process.ts");
const dir = mkdtempSync(join(tmpdir(), "ordertruth-proc-"));
let fake: FakePayPal;
let served: Awaited<ReturnType<typeof serveFakePayPal>>;
const children: ChildProcess[] = [];

beforeAll(async () => {
  fake = new FakePayPal();
  served = await serveFakePayPal(fake);
});
afterEach(async () => {
  // Wait for each kill to finish: on Windows a killed child can still hold the shared SQLite files.
  await Promise.all(children.splice(0).map((c) => c.exitCode !== null || c.signalCode !== null ? undefined
    : new Promise<void>((done) => { c.once("exit", () => done()); c.kill("SIGKILL"); })));
});
afterAll(async () => {
  await served.close();
  // Children have exited; retries only cover brief scanner/indexer locks on Windows (EPERM/EBUSY).
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

type Proc = { child: ChildProcess; port: number; pid: number; startupReconcile: unknown; exited: Promise<number | null>; base: string };

function startProc(db: string, extra: Record<string, string> = {}): Promise<Proc> {
  const child = spawn(process.execPath, ["--no-warnings", "--import", "tsx", HARNESS], {
    env: { ...process.env, OT_DB_PATH: db, OT_FAKE_PAYPAL_URL: served.url, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  let err = "";
  child.stderr!.on("data", (d) => (err += String(d)));
  return new Promise((resolveP, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`child not ready in 20s: ${err.slice(0, 2000)}`)), 20_000);
    child.stdout!.on("data", (d) => {
      out += String(d);
      const line = out.split("\n").find((l) => l.startsWith("{") && l.includes('"ready"'));
      if (line) {
        clearTimeout(t);
        const j = JSON.parse(line);
        resolveP({ child, port: j.port, pid: j.pid, startupReconcile: j.startupReconcile, exited, base: `http://127.0.0.1:${j.port}` });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(t);
      reject(new Error(`child exited ${code} before ready: ${err.slice(0, 2000)}`));
    });
  });
}

const post = (p: Proc, path: string, headers: Record<string, string> = {}) => fetch(p.base + path, { method: "POST", headers });
const dbRow = (db: string, orderId: string) => {
  const d = new DatabaseSync(db);
  try {
    return d.prepare("SELECT id, state, capture_id, capture_request_id FROM payment_attempts WHERE paypal_order_id = ?").get(orderId) as
      | { id: string; state: string; capture_id: string | null; capture_request_id: string }
      | undefined;
  } finally {
    d.close();
  }
};
const postsFor = (orderId: string) => capturePosts(fake).filter((c) => c.path.includes(orderId));

async function createApproved(p: Proc): Promise<string> {
  const r = await post(p, "/api/orders", { "x-checkout-key": newCheckoutKey() });
  expect(r.status).toBe(200);
  const { orderId } = (await r.json()) as { orderId: string };
  fake.approve(orderId);
  return orderId;
}

describe("Two independent server processes on one SQLite file (F3)", () => {
  it("P1 process B's capture during A's in-flight capture POST cannot claim; exactly 1 capture POST", { timeout: 60_000 }, async () => {
    const db = join(dir, "p1.sqlite");
    const a = await startProc(db);
    const b = await startProc(db);
    expect(a.pid).not.toBe(b.pid);
    const orderId = await createApproved(a);

    let release!: () => void;
    let arrived!: () => void;
    const arrival = new Promise<void>((r) => (arrived = r));
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    fake.beforeCaptureApply = () => {
      if (!first) return;
      first = false;
      arrived();
      return gate;
    };
    try {
      const pa = post(a, `/api/orders/${orderId}/capture`);
      await arrival; // A has claimed and its POST is at the provider, unapplied
      const rb = await post(b, `/api/orders/${orderId}/capture`);
      const bodyB = (await rb.json()) as { error?: string; state?: string };
      release();
      const ra = await pa;
      const bodyA = (await ra.json()) as { state: string };
      expect(bodyA.state).toBe("captured");
      expect(rb.status).toBe(409);
      expect(bodyB.error).toBe("capture_in_progress");
      expect(postsFor(orderId)).toHaveLength(1);
      expect(dbRow(db, orderId)!.state).toBe("captured");
    } finally {
      fake.beforeCaptureApply = undefined;
    }
  });
});

describe("Real process crash and restart", () => {
  it("P2 kill right after PayPal's capture 201 -> restarted process reconciles to captured with 0 extra POSTs", { timeout: 60_000 }, async () => {
    const db = join(dir, "p2.sqlite");
    const a = await startProc(db, { OT_CRASH_AT: "after_capture_response" });
    const orderId = await createApproved(a);
    await post(a, `/api/orders/${orderId}/capture`).catch(() => null); // connection dies with the process
    const code = await a.exited;
    expect(code).not.toBe(0);
    expect(postsFor(orderId)).toHaveLength(1);
    expect(fake.orders.get(orderId)!.status).toBe("COMPLETED"); // provider moved the (Sandbox-fake) money
    expect(dbRow(db, orderId)!.state).toBe("capture_in_progress"); // local write never happened

    const r = await startProc(db, { OT_STALE_MS: "0" });
    expect(r.startupReconcile).toMatchObject({ outcomes: [expect.objectContaining({ orderId, to: "captured" })] });
    const status = (await (await fetch(`${r.base}/api/orders/${orderId}`)).json()) as { state: string; captureId: string | null };
    expect(status.state).toBe("captured");
    expect(status.captureId).toBeTruthy();
    expect(postsFor(orderId)).toHaveLength(1);
  });

  it("P3 kill after the claim, before the POST -> restart reconciles to uncertain (no POST); explicit retry -> 1 POST with the stored request id", { timeout: 60_000 }, async () => {
    const db = join(dir, "p3.sqlite");
    const a = await startProc(db, { OT_CRASH_AT: "before_capture_post" });
    const orderId = await createApproved(a);
    await post(a, `/api/orders/${orderId}/capture`).catch(() => null);
    expect(await a.exited).not.toBe(0);
    expect(postsFor(orderId)).toHaveLength(0);
    expect(dbRow(db, orderId)!.state).toBe("capture_in_progress");

    const r = await startProc(db, { OT_STALE_MS: "0", OT_SETTLE_MS: "0" });
    expect(r.startupReconcile).toMatchObject({ outcomes: [expect.objectContaining({ orderId, to: "uncertain" })] });
    expect(postsFor(orderId)).toHaveLength(0); // the reconciler never captures

    const retry = await post(r, `/api/orders/${orderId}/capture`);
    expect(((await retry.json()) as { state: string }).state).toBe("captured");
    const posts = postsFor(orderId);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.headers["PayPal-Request-Id"]).toBe(dbRow(db, orderId)!.capture_request_id);
  });
});
