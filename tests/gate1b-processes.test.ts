// MOCKED provider, REAL processes: the webhook listener runs as its own OS process sharing one
// SQLite file and one HTTP-served FakePayPal. Crashes are forced process kills. Never the Sandbox.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { capturePosts, FakePayPal } from "./fake-paypal.ts";
import { serveFakePayPal } from "./helpers/fake-paypal-http.ts";
import { captureEvent, capturedAtPayPalUnknownLocally, setupWebhook, signedHeaders } from "./helpers/webhook-fixtures.ts";

const HARNESS = resolve("tests/helpers/webhook-process.ts");
const dir = mkdtempSync(join(tmpdir(), "ordertruth-g1b-procs-"));
let fake: FakePayPal;
let served: Awaited<ReturnType<typeof serveFakePayPal>>;
const children: ChildProcess[] = [];
let n = 0;

beforeAll(async () => {
  fake = new FakePayPal();
  served = await serveFakePayPal(fake);
});
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
});
afterAll(async () => {
  await served.close();
  rmSync(dir, { recursive: true, force: true });
});

type Proc = { child: ChildProcess; port: number; abandoned: number; exited: Promise<number | null> };

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
        resolveP({ child, port: j.port, abandoned: j.abandoned, exited });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(t);
      reject(new Error(`child exited ${code} before ready: ${err.slice(0, 2000)}`));
    });
  });
}

const send = (p: Proc, raw: string, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> =>
  fetch(`http://127.0.0.1:${p.port}/webhooks/paypal`, { method: "POST", headers, body: raw }).then(
    async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }),
    () => ({ status: 0, body: {} }), // connection died with the process: no ack
  );
const q = (db: string, sql: string, ...args: Array<string | number>) => {
  const d = new DatabaseSync(db);
  try {
    return d.prepare(sql).all(...args) as Array<Record<string, unknown>>;
  } finally {
    d.close();
  }
};

describe("Gate 1B crash recovery across processes", () => {
  it("K1 killed after PayPal SUCCESS, before the commit -> no ack, no event; restart abandons the delivery; PayPal's redelivery is accepted once", { timeout: 60_000 }, async () => {
    const db = join(dir, `k1-${++n}.sqlite`);
    fake.registeredWebhookId = "TESTWEBHOOK0SANDBOX0001";
    const ev = captureEvent({ orderId: "FOREIGNORDER0000020", captureId: "FOREIGNCAP00020" });
    const raw = JSON.stringify(ev);
    const a = await startProc(db, { OT_CRASH_AT: "webhook_after_verify" });
    const r1 = await send(a, raw, signedHeaders(raw));
    expect(r1.status).toBe(0);
    await a.exited;
    expect(q(db, "SELECT state FROM webhook_deliveries").map((r) => r.state)).toEqual(["received_unverified"]);
    expect(q(db, "SELECT * FROM webhook_events")).toHaveLength(0);

    const b = await startProc(db);
    expect(b.abandoned).toBe(1);
    const r2 = await send(b, raw, signedHeaders(raw)); // PayPal retries with a fresh transmission
    expect(r2).toMatchObject({ status: 200, body: { result: "accepted" } });
    const r3 = await send(b, raw, signedHeaders(raw));
    expect(r3.body.result).toBe("duplicate");
    expect(q(db, "SELECT state FROM webhook_deliveries ORDER BY seq").map((r) => r.state)).toEqual(["abandoned", "verified", "duplicate"]);
    expect(q(db, "SELECT event_id FROM webhook_events").map((r) => r.event_id)).toEqual([ev.id]);
  });

  it("K2 killed after the commit, during processing (before readback) -> restart reclaims the lease and settles by readback with 0 capture POSTs", { timeout: 60_000 }, async () => {
    const db = join(dir, `k2-${++n}.sqlite`);
    const s = await setupWebhook({ path: db, fake });
    const o = await capturedAtPayPalUnknownLocally(s);
    s.store.close();
    const posts = capturePosts(fake).length;
    const ev = captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: o.intentId });
    const raw = JSON.stringify(ev);

    const a = await startProc(db, { OT_CRASH_AT: "webhook_before_readback", OT_LEASE_MS: "300" });
    const r1 = await send(a, raw, signedHeaders(raw));
    await a.exited;
    // The ack may or may not have reached PayPal before the kill; either way the event is durable.
    expect([0, 200]).toContain(r1.status);
    expect(q(db, "SELECT state FROM webhook_events WHERE event_id = ?", ev.id)[0]!.state).toBe("processing");
    expect(q(db, "SELECT state FROM payment_attempts WHERE paypal_order_id = ?", o.orderId)[0]!.state).toBe("uncertain");

    await new Promise((r) => setTimeout(r, 400)); // lease expires
    const b = await startProc(db, { OT_LEASE_MS: "300" });
    const row = q(db, "SELECT state, process_attempts FROM webhook_events WHERE event_id = ?", ev.id)[0]!;
    expect(row).toEqual({ state: "processed", process_attempts: 2 });
    expect(q(db, "SELECT state FROM payment_attempts WHERE paypal_order_id = ?", o.orderId)[0]!.state).toBe("captured");
    expect(capturePosts(fake)).toHaveLength(posts);
    // A redelivery after recovery is a duplicate and is not processed again.
    expect((await send(b, raw, signedHeaders(raw))).body.result).toBe("duplicate");
  });
});
