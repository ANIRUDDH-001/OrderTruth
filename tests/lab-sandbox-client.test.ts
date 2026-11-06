/** OFFLINE ONLY. The test transport is permanently TEST branded. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLabSandboxClient, createLabSandboxClient, createOfflineLabSandboxClientForTest, getLabSandboxPayPalClient, isLabSandboxClient, labClientAuthority } from "../src/merchant/lab-sandbox-client.ts";
import { PayPalClient, type FetchLike } from "../src/paypal/client.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const credentials = { clientId: "offline-client-id", clientSecret: "offline-client-secret" };
const meta = { correlationId: "offline-test" };
function setup(mode: "reuse" | "temporary" = "reuse", custom?: FetchLike) {
  const dir = mkdtempSync(join(tmpdir(), "ot-client-budget-")); dirs.push(dir);
  const options = { budgetFile: join(dir, "budget.jsonl"), registrationMode: mode };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport: FetchLike = custom ?? (async (url, init) => {
    calls.push({ url, init });
    const body = url.endsWith("/oauth2/token") ? { access_token: "OFFLINE-ACCESS-TOKEN", expires_in: 3600 } : { id: "OFFLINE-ID", status: "COMPLETED", verification_status: "SUCCESS" };
    return new Response(init.method === "DELETE" ? null : JSON.stringify(body), { status: init.method === "DELETE" ? 204 : 200, headers: { "paypal-debug-id": "SAFE-DEBUG-ID" } });
  });
  const client = createOfflineLabSandboxClientForTest(credentials, options, transport);
  return { dir, options, transport, calls, client };
}
describe("constrained isolated Sandbox client", () => {
  it("brands exact live-factory object without making a provider request", () => {
    const f = setup();
    const client = createLabSandboxClient(credentials, f.options);
    expect(isLabSandboxClient(client)).toBe(true); expect(labClientAuthority(client)).toBe("PAYPAL");
    expect(getLabSandboxPayPalClient(client)).toBeInstanceOf(PayPalClient);
    expect(Object.isFrozen(client)).toBe(true); expect(client.apiBase).toBe("https://api-m.sandbox.paypal.com");
    expect(f.calls).toHaveLength(0);
  });
  it("rejects mock transport clients, lookalikes, clones, proxies and unbranded PayPalClient", () => {
    const f = setup();
    expect(labClientAuthority(f.client)).toBe("TEST");
    for (const value of [f.client, { ...f.client }, new Proxy(f.client, {}), {}, new PayPalClient({ ...credentials, env: "sandbox", apiBase: "https://api-m.sandbox.paypal.com", webhookId: undefined, timeoutMs: 1000 }, f.transport)]) {
      expect(() => assertLabSandboxClient(value)).toThrow(/trusted Sandbox/);
      expect(() => getLabSandboxPayPalClient(value)).toThrow(/trusted Sandbox/);
    }
  });
  it.each(["apiBase", "fetch", "provider", "env"])("rejects runtime extra %s configuration without echoing values", (key) => {
    const f = setup();
    expect(() => createLabSandboxClient(JSON.parse(JSON.stringify({ ...credentials, [key]: "DO-NOT-ECHO" })) as typeof credentials, f.options)).toThrow("unsupported configuration fields");
    expect(f.calls).toHaveLength(0);
  });
  it("rejects accessors and extra options/factory arguments", () => {
    const f = setup(); const getter = vi.fn(() => "secret");
    expect(() => createLabSandboxClient({ clientId: "offline", get clientSecret() { return getter(); } }, f.options)).toThrow(/unsupported/);
    expect(getter).not.toHaveBeenCalled();
    expect(() => createLabSandboxClient(credentials, { ...f.options, fetch: f.transport } as typeof f.options)).toThrow(/unsupported/);
    expect(() => Reflect.apply(createLabSandboxClient, null, [credentials, f.options, f.transport])).toThrow(/unsupported/);
  });
  it("uses fixed Sandbox URLs, redirect:error and durable reservation before each transport invocation", async () => {
    const f = setup();
    await f.client.createOrder({}, "offline-request", meta);
    expect(f.calls).toHaveLength(2);
    expect(f.calls.every((c) => c.url.startsWith("https://api-m.sandbox.paypal.com/") && c.init.redirect === "error")).toBe(true);
    expect(f.client.budgetSnapshot()).toMatchObject({ total: 2, maximum: 23, counts: { oauth: 1, createOrder: 1 } });
    const records = readFileSync(f.options.budgetFile, "utf8");
    expect(records).toContain('"operation":"oauth"'); expect(records).not.toContain(credentials.clientSecret); expect(records).not.toContain("OFFLINE-ACCESS-TOKEN");
  });
  it("enforces every operation ceiling and temporary total25, with failed excess calls never fetching", async () => {
    const f = setup("temporary");
    await f.client.checkAuth(meta); await f.client.checkAuth(meta);
    await f.client.createOrder({}, "offline-request", meta);
    await f.client.captureOrder("ORDER1", "offline-request", meta);
    for (let n = 0; n < 12; n++) await f.client.getOrder("ORDER1", meta);
    for (let n = 0; n < 5; n++) await f.client.verifyWebhookSignature("{}", meta, 500);
    await f.client.getWebhook("WEBHOOK1", meta);
    await f.client.createWebhook({ url: "https://example.invalid/webhook", event_types: [{ name: "PAYMENT.CAPTURE.COMPLETED" }] }, meta);
    await f.client.deleteWebhook("WEBHOOK1", meta);
    expect(f.client.budgetSnapshot()).toEqual({ total: 25, maximum: 25, counts: { oauth: 3, createOrder: 1, captureOrder: 1, getOrder: 12, verifySignature: 5, getWebhook: 1, createWebhook: 1, deleteWebhook: 1 } });
    const attempts = [() => f.client.checkAuth(meta), () => f.client.createOrder({}, "retry", meta), () => f.client.captureOrder("ORDER1", "retry", meta), () => f.client.getOrder("ORDER1", meta), () => f.client.verifyWebhookSignature("{}", meta, 500), () => f.client.getWebhook("WEBHOOK1", meta), () => f.client.createWebhook({ url: "https://example.invalid", event_types: [] }, meta), () => f.client.deleteWebhook("WEBHOOK1", meta)];
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow();
    expect(f.calls).toHaveLength(25);
  });
  it.each([
    ["oauth", 3], ["createOrder", 1], ["captureOrder", 1], ["getOrder", 12], ["verifySignature", 5], ["getWebhook", 1], ["createWebhook", 1], ["deleteWebhook", 1],
  ] as const)("enforces %s independently before the total ceiling", async (operation, count) => {
    const f = setup("temporary");
    const invoke = () => {
      switch (operation) {
        case "oauth": return f.client.checkAuth(meta);
        case "createOrder": return f.client.createOrder({}, "offline-request", meta);
        case "captureOrder": return f.client.captureOrder("ORDER1", "offline-request", meta);
        case "getOrder": return f.client.getOrder("ORDER1", meta);
        case "verifySignature": return f.client.verifyWebhookSignature("{}", meta, 500);
        case "getWebhook": return f.client.getWebhook("WEBHOOK1", meta);
        case "createWebhook": return f.client.createWebhook({ url: "https://example.invalid", event_types: [] }, meta);
        case "deleteWebhook": return f.client.deleteWebhook("WEBHOOK1", meta);
      }
    };
    for (let n = 0; n < count; n++) await invoke();
    const before = f.calls.length;
    await expect(invoke()).rejects.toThrow();
    expect(f.calls).toHaveLength(before); expect(f.client.budgetSnapshot().counts[operation]).toBe(count);
    expect(f.client.budgetSnapshot().total).toBeLessThan(25);
  });
  it("reuse policy permits max23 and rejects registration mutations before OAuth", async () => {
    const f = setup();
    await expect(f.client.createWebhook({ url: "https://example.invalid", event_types: [] }, meta)).rejects.toThrow(/not authorized/);
    await expect(f.client.deleteWebhook("WEBHOOK1", meta)).rejects.toThrow(/not authorized/);
    expect(f.calls).toHaveLength(0); expect(f.client.budgetSnapshot().maximum).toBe(23);
  });
  it("retains spent counters across factory/bootstrap restart and independent instances", async () => {
    const f = setup(); await f.client.createOrder({}, "one", meta);
    const restarted = createOfflineLabSandboxClientForTest(credentials, f.options, f.transport);
    expect(restarted.budgetSnapshot().counts.createOrder).toBe(1);
    const before = f.calls.length;
    await expect(restarted.createOrder({}, "two", meta)).rejects.toThrow();
    expect(f.calls).toHaveLength(before);
    expect(restarted.budgetSnapshot().counts.oauth).toBe(1);
    expect(f.calls.filter((c) => c.url.endsWith("/v2/checkout/orders"))).toHaveLength(1);
  });
  it("concurrent independent instances cannot exceed the capture ceiling", async () => {
    const f = setup(); const other = createOfflineLabSandboxClientForTest(credentials, f.options, f.transport);
    const results = await Promise.allSettled([f.client.captureOrder("ORDER1", "one", meta), other.captureOrder("ORDER1", "two", meta)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(f.calls.filter((c) => c.url.endsWith("/capture"))).toHaveLength(1);
  });
  it("failed HTTP and timeout attempts consume capacity and sanitize provider errors/debug IDs", async () => {
    let n = 0;
    const f = setup("reuse", async () => ++n === 1
      ? new Response(JSON.stringify({ access_token: "OFFLINE-TOKEN", expires_in: 3600 }), { status: 200 })
      : new Response(JSON.stringify({ name: credentials.clientSecret, details: [{ issue: "OFFLINE-TOKEN" }] }), { status: 500, headers: { "paypal-debug-id": credentials.clientSecret } }));
    await expect(f.client.captureOrder("ORDER1", "one", meta)).rejects.toMatchObject({ debugId: null, issues: ["SANDBOX_HTTP_ERROR"] });
    expect(f.client.budgetSnapshot().counts.captureOrder).toBe(1);
    expect(f.client.requestEvidence().at(-1)).toEqual({ operation: "captureOrder", httpStatus: 500, debugId: null, outcome: "response" });
    const restartedTransport = vi.fn(async () => new Response(JSON.stringify({ access_token: "OFFLINE-TOKEN", expires_in: 3600 }), { status: 200 }));
    const restarted = createOfflineLabSandboxClientForTest(credentials, f.options, restartedTransport);
    await expect(restarted.captureOrder("ORDER1", "restart", meta)).rejects.toThrow();
    expect(restartedTransport).not.toHaveBeenCalled();
    expect(restarted.budgetSnapshot().counts.captureOrder).toBe(1);
    await expect(f.client.captureOrder("ORDER1", "two", meta)).rejects.toThrow(); expect(n).toBe(2);
    const timeout = setup("reuse", async () => { throw new Error("OFFLINE-TOKEN secret timeout"); });
    await expect(timeout.client.checkAuth(meta)).rejects.toThrow(/network/);
    expect(timeout.client.budgetSnapshot().counts.oauth).toBe(1);
    expect(timeout.client.requestEvidence()).toEqual([{ operation: "oauth", httpStatus: null, debugId: null, outcome: "transport_error" }]);
  });
  it("rejects redirects without following and preserves their spent budget", async () => {
    const f = setup("reuse", async () => new Response(null, { status: 302, headers: { location: "https://api-m.paypal.com/" } }));
    await expect(f.client.checkAuth(meta)).rejects.toThrow(); expect(f.client.budgetSnapshot().counts.oauth).toBe(1);
  });
  it("never records an access token disguised as a syntactically valid debug ID", async () => {
    const f = setup("reuse", async () => new Response(JSON.stringify({ access_token: "OFFLINE_ACCESS_TOKEN", expires_in: 3600 }), { status: 200, headers: { "paypal-debug-id": "OFFLINE_ACCESS_TOKEN" } }));
    expect((await f.client.checkAuth(meta)).debugId).toBeNull();
    expect(f.client.requestEvidence()[0]?.debugId).toBeNull();
    const sidecar = readFileSync(f.options.budgetFile + ".evidence.jsonl", "utf8");
    expect(JSON.parse(sidecar)).toEqual({ operation: "oauth", httpStatus: 200, debugId: null, outcome: "response" });
    expect(sidecar).not.toContain("OFFLINE_ACCESS_TOKEN"); expect(sidecar).not.toContain(credentials.clientSecret);
    createOfflineLabSandboxClientForTest(credentials, f.options, f.transport);
    expect(readFileSync(f.options.budgetFile + ".evidence.jsonl", "utf8")).toBe(sidecar);
  });
  it("persists sanitized HTTP and transport errors and never refunds quota after sidecar failure", async () => {
    const errors = setup("reuse", async () => new Response(JSON.stringify({ name: credentials.clientSecret }), { status: 500, headers: { "paypal-debug-id": credentials.clientSecret } }));
    await expect(errors.client.checkAuth(meta)).rejects.toThrow();
    expect(JSON.parse(readFileSync(errors.options.budgetFile + ".evidence.jsonl", "utf8"))).toEqual({ operation: "oauth", httpStatus: 500, debugId: null, outcome: "response" });
    const transport = setup("reuse", async () => { throw new Error(credentials.clientSecret); });
    await expect(transport.client.checkAuth(meta)).rejects.toThrow();
    expect(JSON.parse(readFileSync(transport.options.budgetFile + ".evidence.jsonl", "utf8"))).toEqual({ operation: "oauth", httpStatus: null, debugId: null, outcome: "transport_error" });
    const blocked = setup(); mkdirSync(blocked.options.budgetFile + ".evidence.jsonl");
    await expect(blocked.client.checkAuth(meta)).rejects.toThrow(/evidence persistence failed/);
    expect(blocked.calls).toHaveLength(1); expect(blocked.client.budgetSnapshot().counts.oauth).toBe(1);
    expect(blocked.client.requestEvidence()).toHaveLength(1);
    await expect(blocked.client.checkAuth(meta)).rejects.toMatchObject({ outcomeUnknown: true });
    expect(blocked.calls).toHaveLength(1);
  });
  it("rejects malformed debug IDs while accepting bounded underscore IDs", async () => {
    const good = setup("reuse", async () => new Response(JSON.stringify({ access_token: "OFFLINE_TOKEN", expires_in: 3600 }), { headers: { "paypal-debug-id": "SAFE_DEBUG_1" } }));
    expect((await good.client.checkAuth(meta)).debugId).toBe("SAFE_DEBUG_1");
    const bad = setup("reuse", async () => new Response(JSON.stringify({ access_token: "OFFLINE_TOKEN", expires_in: 3600 }), { headers: { "paypal-debug-id": "unsafe debug value" } }));
    expect((await bad.client.checkAuth(meta)).debugId).toBeNull();
  });
  it("fails closed on partial journal, policy mismatch and stale lock", async () => {
    const f = setup(); writeFileSync(f.options.budgetFile, '{"version":1');
    expect(() => createOfflineLabSandboxClientForTest(credentials, f.options, f.transport)).toThrow(/incomplete/);
    writeFileSync(f.options.budgetFile, '{"version":1,"registrationMode":"temporary"}\n');
    expect(() => createOfflineLabSandboxClientForTest(credentials, f.options, f.transport)).toThrow(/policy mismatch/);
    rmSync(f.options.budgetFile); writeFileSync(f.options.budgetFile + ".lock", "");
    await expect(f.client.checkAuth(meta)).rejects.toThrow(); expect(f.calls).toHaveLength(0);
  });
});
