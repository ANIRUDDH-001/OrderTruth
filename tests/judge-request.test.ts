import { afterEach,describe, expect, it,vi } from "vitest";
import { RequestError, requestJson, slowNotice,REQUEST_BUDGET_MS } from "../web/judge/request.ts";

type Call = { path: string; method: string };
function fakeFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const impl = (async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? "GET" });
    const next = responses.shift();
    if (!next) throw new Error("No scripted response left");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noSleep = async () => {};

describe("judge requests", () => {
  it("retries a GET through a cold-start gateway error and returns the body", async () => {
    const { impl, calls } = fakeFetch([json(504), json(502), json(200, { ok: true })]);
    await expect(requestJson<{ ok: boolean }>("/api/session", undefined, { fetchImpl: impl, sleep: noSleep })).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(calls.every(c => c.method === "GET")).toBe(true);
  });

  it("retries a GET after a network failure", async () => {
    const { impl, calls } = fakeFetch([new TypeError("Failed to fetch"), json(200, { ok: true })]);
    await expect(requestJson("/api/health", undefined, { fetchImpl: impl, sleep: noSleep })).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("never retries a POST, even on a gateway error", async () => {
    const { impl, calls } = fakeFetch([json(503, { error: "Scenario unavailable" }), json(200)]);
    await expect(requestJson("/api/scenarios", {}, { fetchImpl: impl, sleep: noSleep })).rejects.toMatchObject({ status: 503, message: "Scenario unavailable" });
    expect(calls).toEqual([{ path: "/api/scenarios", method: "POST" }]);
  });

  it("never retries a POST after a network failure", async () => {
    const { impl, calls } = fakeFetch([new TypeError("Failed to fetch"), json(200)]);
    await expect(requestJson("/api/scenarios/r1/execute", { planId: "p" }, { fetchImpl: impl, sleep: noSleep })).rejects.toBeInstanceOf(RequestError);
    expect(calls).toHaveLength(1);
  });

  it("does not retry client errors", async () => {
    const { impl, calls } = fakeFetch([json(404, { error: "Scenario not found" })]);
    await expect(requestJson("/api/scenarios/r1", undefined, { fetchImpl: impl, sleep: noSleep })).rejects.toMatchObject({ status: 404, message: "Scenario not found" });
    expect(calls).toHaveLength(1);
  });

  it("stops retrying after the attempt budget and reports the last status", async () => {
    const { impl, calls } = fakeFetch(Array.from({ length: 10 }, () => json(503)));
    await expect(requestJson("/api/session", undefined, { fetchImpl: impl, sleep: noSleep, attempts: 4 })).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(4);
  });

  it("prefers the server's message, then its error code, then a status fallback", async () => {
    const { impl } = fakeFetch([json(429, { error: "limit", message: "Demo action allowance reached" }), json(409, { error: "Case changed" }), new Response("not json", { status: 400 })]);
    await expect(requestJson("/a", {}, { fetchImpl: impl, sleep: noSleep })).rejects.toThrow("Demo action allowance reached");
    await expect(requestJson("/a", {}, { fetchImpl: impl, sleep: noSleep })).rejects.toThrow("Case changed");
    await expect(requestJson("/a", {}, { fetchImpl: impl, sleep: noSleep })).rejects.toThrow("Request unavailable (400)");
  });

  it("explains a network failure in plain language with status 0", async () => {
    const { impl } = fakeFetch([new TypeError("Failed to fetch")]);
    await expect(requestJson("/a", {}, { fetchImpl: impl, sleep: noSleep })).rejects.toMatchObject({ status: 0, message: expect.stringMatching(/could not reach/i) });
  });

  it("waits with increasing, capped delays between GET retries", async () => {
    const waits: number[] = [];
    const { impl } = fakeFetch([json(503), json(503), json(503), json(503), json(200)]);
    await requestJson("/api/session", undefined, { fetchImpl: impl, sleep: async ms => { waits.push(ms); }, attempts: 5 });
    expect(waits).toEqual([2000, 4000, 8000, 10000]);
  });
});

describe("slow-request notice", () => {
  it("gives conditional status without promising a host startup ceiling", () => {
    expect(slowNotice(1_999)).toBe("");
    expect(slowNotice(2_000)).toMatch(/may be waking.*or busy/i);
    expect(slowNotice(90_000)).not.toMatch(/up to a minute/);
    expect(slowNotice(23_400)).toContain("23 s");
  });
});

describe("total request deadline and invalid responses",() => {
  afterEach(() => vi.useRealTimers());
  for (const body of [undefined,{}]) {
    it(`bounds stalled headers and sends ${body === undefined ? "GET" : "POST"} once`,async () => {
      vi.useFakeTimers(); let calls = 0; let signal: AbortSignal|undefined;
      const fetchImpl = (async (_p: unknown,init?: RequestInit) => { calls++; signal = init?.signal as AbortSignal; return new Promise<Response>(() => {}); }) as typeof fetch;
      const pending = expect(requestJson("/case",body,{ fetchImpl,deadlineMs: 100 })).rejects.toMatchObject({ kind: "TIMEOUT",outcomeUnknown: body !== undefined });
      await vi.advanceTimersByTimeAsync(100); await pending;
      expect(calls).toBe(1); expect(signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    });
  }
  it("bounds a stalled body even when the injected transport ignores abort",async () => {
    vi.useFakeTimers();
    const fetchImpl = (async () => ({ ok: true,status: 200,json: () => new Promise(() => {}) })) as unknown as typeof fetch;
    const pending = expect(requestJson("/case",undefined,{ fetchImpl,deadlineMs: 100 })).rejects.toMatchObject({ kind: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(100); await pending; expect(vi.getTimerCount()).toBe(0);
  });
  it("includes GET backoff in the same total deadline",async () => {
    vi.useFakeTimers();const f = fakeFetch([json(503),json(200)]);
    const pending = expect(requestJson("/case",undefined,{ fetchImpl: f.impl,deadlineMs: 100 })).rejects.toMatchObject({ kind: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(100); await pending; expect(f.calls).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
  for (const body of [undefined,{}]) {
    it(`rejects malformed successful JSON without replaying ${body === undefined ? "GET" : "POST"}`,async () => {
      const f = fakeFetch([new Response("not JSON",{ status: 200 })]);
      await expect(requestJson("/case",body,{ fetchImpl: f.impl })).rejects.toMatchObject({ kind: "INVALID_RESPONSE",outcomeUnknown: body !== undefined });
      expect(f.calls).toHaveLength(1);
    });
  }
  it("clears the deadline after a normal response",async () => {
    vi.useFakeTimers();const f = fakeFetch([json(200,{ ok: true })]);
    await expect(requestJson("/case",undefined,{ fetchImpl: f.impl })).resolves.toEqual({ ok: true });expect(vi.getTimerCount()).toBe(0);
  });
  it("uses the documented finite default POST budget",async () => {
    vi.useFakeTimers();const fetchImpl = (() => new Promise<Response>(() => {})) as typeof fetch;
    const pending = expect(requestJson("/case",{}, { fetchImpl })).rejects.toMatchObject({ kind: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(REQUEST_BUDGET_MS.write);await pending;
  });
  it("rejects an infinite deadline instead of creating an unbounded request",async () => {
    await expect(requestJson("/case",undefined,{ deadlineMs: Infinity })).rejects.toThrow("Invalid request wait budget");
  });
});
