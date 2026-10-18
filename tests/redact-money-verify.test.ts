import { describe, expect, it } from "vitest";
import { maskId, redactString, redactValue } from "../src/redact.ts";
import { parseProviderValue, toProviderValue } from "../src/domain/money.ts";
import { verifyCaptureReadback, type OrderReadback } from "../src/domain/checkout.ts";

describe("redaction", () => {
  it("removes known secrets, bearer tokens, access_token fields and Google keys", () => {
    const s = redactString('Authorization: Bearer A21AAabcdefghijklmnopqrstuvwxyz {"access_token":"tok123456"} key=AIzaSyA1234567890abcdefghijk my-secret-xyz', ["my-secret-xyz"]);
    expect(s).not.toMatch(/A21AAabc|tok123456|AIzaSyA123|my-secret-xyz/);
  });
  it("drops buyer PII and credentials by key in nested objects", () => {
    const v = redactValue({ payer: { email_address: "a@b.c" }, nested: [{ authorization: "Basic xyz", ok: 1 }] }) as any;
    expect(JSON.stringify(v)).not.toContain("a@b.c");
    expect(v.nested[0].authorization).toBe("[REDACTED]");
    expect(v.nested[0].ok).toBe(1);
  });
  it("masks identifiers", () => {
    expect(maskId("ABCDEFGHIJK")).toBe("ABC…IJK");
    expect(maskId(undefined)).toBeNull();
  });
});

describe("money", () => {
  it("formats integer minor units", () => {
    expect(toProviderValue({ currency: "USD", minor: 100 })).toBe("1.00");
    expect(toProviderValue({ currency: "USD", minor: 5 })).toBe("0.05");
    expect(() => toProviderValue({ currency: "USD", minor: 1.5 })).toThrow();
  });
  it("parses strictly", () => {
    expect(parseProviderValue("1.00", "USD")).toEqual({ currency: "USD", minor: 100 });
    expect(parseProviderValue("1.5", "USD")).toEqual({ currency: "USD", minor: 150 });
    expect(parseProviderValue("1.001", "USD")).toBeNull();
    expect(parseProviderValue(1, "USD")).toBeNull();
    expect(parseProviderValue("1.00", "EUR")).toBeNull();
  });
});

const expected = { orderId: "ORDER1234", amount: { currency: "USD" as const, minor: 100 }, customId: "ci_1" };
const rb = (cap: Record<string, unknown> | null, over: Partial<OrderReadback> = {}): OrderReadback => ({
  id: "ORDER1234",
  status: cap ? "COMPLETED" : "APPROVED",
  intent: "CAPTURE",
  purchase_units: [{ custom_id: "ci_1", amount: { currency_code: "USD", value: "1.00" }, ...(cap ? { payments: { captures: [cap as any] } } : {}) }],
  ...over,
});

describe("verifyCaptureReadback (deterministic verdict)", () => {
  it("captured only when COMPLETED and amount/currency/id match", () => {
    const v = verifyCaptureReadback(rb({ id: "C1", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } }), expected);
    expect(v.state).toBe("captured");
    expect(v.captured).toEqual({ currency: "USD", minor: 100 });
  });
  it("pending is not captured", () => {
    expect(verifyCaptureReadback(rb({ id: "C1", status: "PENDING", amount: { currency_code: "USD", value: "1.00" }, status_details: { reason: "RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION" } }), expected).state).toBe("pending");
  });
  it("declined is denied", () => {
    expect(verifyCaptureReadback(rb({ id: "C1", status: "DECLINED", amount: { currency_code: "USD", value: "1.00" } }), expected).state).toBe("denied");
  });
  it("amount mismatch is flagged even if COMPLETED", () => {
    expect(verifyCaptureReadback(rb({ id: "C1", status: "COMPLETED", amount: { currency_code: "USD", value: "100.00" } }), expected).state).toBe("mismatch");
  });
  it("wrong order id is mismatch", () => {
    expect(verifyCaptureReadback(rb(null, { id: "OTHER" }), expected).state).toBe("mismatch");
  });
  it("no capture yet is uncertain, never captured", () => {
    expect(verifyCaptureReadback(rb(null), expected).state).toBe("uncertain");
  });
  it("unknown capture status is uncertain", () => {
    expect(verifyCaptureReadback(rb({ id: "C1", status: "WEIRD", amount: { currency_code: "USD", value: "1.00" } }), expected).state).toBe("uncertain");
  });
});
