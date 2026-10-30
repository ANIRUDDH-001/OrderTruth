import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { signCapability, verifyMac, type CaptureCapability } from "../../packages/guard/src/capability.ts";

const fixture = JSON.parse(readFileSync(new URL("../../packages/guard/fixtures/synthetic-fixture.json", import.meta.url), "utf8")) as {
  provenance: string; merchants: string[]; observations: Array<Record<string, string>> };
const paypalKey = Buffer.alloc(32, 1), testKey = Buffer.alloc(32, 2);
const base: Omit<CaptureCapability, "mac"> = { authority: "TEST", provenance: "SYNTHETIC_FIXTURE", merchantId: "SYN-M-A", paypalEnv: "sandbox",
  payeeMerchantId: "SYN-PAYEE-1", paypalOrderId: "SYN-ORD-1", captureId: "SYN-CAP-1", status: "COMPLETED", currency: "USD", amountMinor: "1000",
  intentId: "SYN-INT-1", verificationMethod: "FIXTURE", observedAt: "2026-10-30T00:00:00.000Z", responseHash: "SYN-RESP-1", evidenceId: "e".repeat(64) };
const alternatives: Record<keyof Omit<CaptureCapability, "mac">, string> = { authority: "PAYPAL", provenance: "PAYPAL_READBACK", merchantId: "SYN-M-B",
  paypalEnv: "live", payeeMerchantId: "SYN-PAYEE-2", paypalOrderId: "SYN-ORD-9", captureId: "SYN-CAP-9", status: "PENDING", currency: "EUR",
  amountMinor: "1001", intentId: "SYN-INT-9", verificationMethod: "READBACK", observedAt: "2026-10-30T00:00:00.001Z", responseHash: "SYN-RESP-9", evidenceId: "f".repeat(64) };

describe("capture capabilities (spec §6, §6.1)", () => {
  it("verifies under the key that signed it, and under neither authority's key for the other's capability", () => {
    const test = signCapability(base, testKey), paypal = signCapability({ ...base, authority: "PAYPAL", provenance: "PAYPAL_READBACK" }, paypalKey);
    expect(verifyMac(test, testKey)).toBe(true);
    expect(verifyMac(paypal, paypalKey)).toBe(true);
    expect(verifyMac(test, paypalKey)).toBe(false);
    expect(verifyMac(paypal, testKey)).toBe(false);
    expect(test.mac).toMatch(/^[0-9a-f]{64}$/);
  });
  it("fails verification when any single field changes", () => {
    const signed = signCapability(base, testKey);
    for (const field of Object.keys(alternatives) as Array<keyof typeof alternatives>)
      expect(verifyMac({ ...signed, [field]: alternatives[field] } as CaptureCapability, testKey), field).toBe(false);
  });
  it("rejects a hand-written capability and a malformed MAC without throwing", () => {
    expect(verifyMac({ ...base, mac: "00".repeat(32) }, testKey)).toBe(false);
    expect(verifyMac({ ...base, mac: "zz" }, testKey)).toBe(false);
    expect(verifyMac({ ...base, mac: "" }, testKey)).toBe(false);
  });
  it("ships a synthetic fixture whose IDs are all SYN- prefixed, with an amended observation of SYN-CAP-1", () => {
    expect(fixture.provenance).toBe("SYNTHETIC_FIXTURE");
    for (const o of fixture.observations) {
      expect(o.provenance).toBe("SYNTHETIC_FIXTURE");
      expect(o.authority).toBe("TEST");
      for (const k of ["observationId", "merchantId", "payeeMerchantId", "paypalOrderId", "captureId", "intentId", "responseHash", "observationHash"])
        expect(o[k], `${o.observationId}.${k}`).toMatch(/^SYN-/);
    }
    for (const m of fixture.merchants) expect(m).toMatch(/^SYN-/);
    const one = fixture.observations.find(o => o.observationId === "SYN-OBS-1")!, oneB = fixture.observations.find(o => o.observationId === "SYN-OBS-1B")!;
    expect(oneB.captureId).toBe(one.captureId);
    expect(oneB.amountMinor).not.toBe(one.amountMinor);
  });
});
