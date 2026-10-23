import { describe, expect, it } from "vitest";
import { RequestError, requestJson, slowNotice } from "../web/judge/request.ts";

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
  it("stays quiet for quick requests and explains the free-tier wake-up after a few seconds", () => {
    expect(slowNotice(4_999)).toBe("");
    expect(slowNotice(5_000)).toMatch(/free-tier server.*up to a minute/i);
    expect(slowNotice(23_400)).toContain("23 s");
  });
});
