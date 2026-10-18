import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

const good = {
  PAYPAL_ENV: "sandbox",
  PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
  PAYPAL_CLIENT_ID: "cid",
  PAYPAL_CLIENT_SECRET: "super-secret-value",
  AI_PROVIDER: "disabled",
};

function errOf(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error("expected ConfigError");
}

describe("config", () => {
  it("accepts a complete sandbox config", () => {
    const c = loadConfig(good);
    expect(c.paypal.apiBase).toBe("https://api-m.sandbox.paypal.com");
    expect(c.secrets).toContain("super-secret-value");
  });

  it.each(["https://api-m.paypal.com", "https://api.paypal.com", "https://api-m.paypal.com/v1"])("hard-blocks production host %s", (host) => {
    const e = errOf({ ...good, PAYPAL_API_BASE: host });
    expect(e.keys).toEqual(["PAYPAL_API_BASE"]);
    expect(e.message).toMatch(/Production/);
  });

  it("rejects any non-sandbox host, even lookalikes", () => {
    expect(errOf({ ...good, PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com.evil.test" }).keys).toContain("PAYPAL_API_BASE");
    expect(errOf({ ...good, PAYPAL_API_BASE: "http://api-m.sandbox.paypal.com" }).keys).toContain("PAYPAL_API_BASE");
  });

  it("rejects PAYPAL_ENV=live", () => {
    expect(errOf({ ...good, PAYPAL_ENV: "live" }).keys).toEqual(["PAYPAL_ENV"]);
  });

  it("reports missing mandatory keys by name, never by value", () => {
    const e = errOf({ PAYPAL_ENV: "sandbox", PAYPAL_API_BASE: good.PAYPAL_API_BASE, PAYPAL_CLIENT_SECRET: "   " });
    expect(e.keys).toEqual(expect.arrayContaining(["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]));
    expect(e.message).not.toContain("super-secret-value");
  });

  it("does not leak secret values in error messages", () => {
    const e = errOf({ ...good, PAYPAL_ENV: "production" });
    expect(JSON.stringify({ m: e.message, k: e.keys })).not.toContain("super-secret-value");
  });

  it("requires an API key when gemini is selected (case-insensitive provider)", () => {
    expect(errOf({ ...good, AI_PROVIDER: "GEMINI" }).keys).toEqual(["AI_API_KEY"]);
    expect(loadConfig({ ...good, AI_PROVIDER: "GEMINI", AI_API_KEY: "k-123456" }).ai.provider).toBe("gemini");
  });
});
