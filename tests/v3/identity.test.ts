import { describe, expect, it } from "vitest";
import { CONTRACT, KEY_VERSION, effectEventId, evidenceEventId, evidenceId, fingerprintP1, obligationKeyP1, validateAmountMinor, validateIdentifier,
  type EventScope, type P1FingerprintInput } from "../../packages/guard/src/identity.ts";

const key = (payeeMerchantId: string, captureId: string) => obligationKeyP1({ paypalEnv: "sandbox", payeeMerchantId, captureId, unit: "primary" });
const scope = (over: Partial<EventScope> = {}): EventScope => ({ merchantId: "SYN-M-A", authority: "TEST", paypalEnv: "sandbox", payeeMerchantId: "SYN-PAYEE-1",
  operationKind: "CREATE_ORDER", obligationKey: key("SYN-PAYEE-1", "SYN-CAP-1"), eventKind: "order.created", contractVersion: CONTRACT.version, ...over });
const fingerprintInput: P1FingerprintInput = { captureId: "SYN-CAP-1", paypalOrderId: "SYN-ORD-1", intentId: "SYN-INT-1", currency: "USD", amountMinor: "1000", linesHash: "lines-1" };

describe("v3 obligation key (spec §5.2a)", () => {
  it("encodes the canonical P1 key with length-prefixed parts", () => {
    expect(KEY_VERSION).toBe(1);
    expect(CONTRACT).toEqual({ id: "OT_V3_OBLIGATION", version: "0.1.0" });
    expect(key("SYN-PAYEE-1", "SYN-CAP-1")).toBe("v1|P1|7:sandbox|11:SYN-PAYEE-1|9:SYN-CAP-1|7:primary");
  });
  it("counts code points, as PostgreSQL length() does, not UTF-16 units", () => {
    expect(key("SYN-PAYEE-1", "\u{1D11E}a")).toContain("|2:\u{1D11E}a|");
  });
  it("keeps identities distinct even when values contain the separators", () => {
    expect(key("a|1:b", "c")).not.toBe(key("a", "1:b|c"));
  });
  it("refuses to build a key from invalid parts instead of producing one the database would store differently", () => {
    for (const [payee, capture] of [["SYN-PAYEE-1", "\uD800"], ["", "SYN-CAP-1"], ["SYN-PAYEE-1", "c".repeat(129)], ["SYN-PAYEE-1", "a\u0000"]])
      expect(() => key(payee!, capture!), JSON.stringify([payee, capture])).toThrow(/invalid/);
    expect(() => obligationKeyP1({ paypalEnv: "live" as "sandbox", payeeMerchantId: "SYN-PAYEE-1", captureId: "SYN-CAP-1", unit: "primary" })).toThrow(/sandbox/);
    expect(() => obligationKeyP1({ paypalEnv: "sandbox", payeeMerchantId: "SYN-PAYEE-1", captureId: "SYN-CAP-1", unit: "split" as "primary" })).toThrow(/unit/);
    expect(() => obligationKeyP1({ paypalEnv: "sandbox", payeeMerchantId: "SYN-PAYEE-1", captureId: "SYN-CAP-1", unit: "primary" }, 2)).toThrow(/key version/);
  });
  it("matches the three Checkpoint 0 smoke vectors exactly", () => {
    expect([key("SYN-PAYEE-1", "SYN-CAP-1"), key("SYN-PAYEE-1", "\u{1D11E}a"), key("a|1:b", "c")]).toEqual([
      "v1|P1|7:sandbox|11:SYN-PAYEE-1|9:SYN-CAP-1|7:primary",
      "v1|P1|7:sandbox|11:SYN-PAYEE-1|2:\u{1D11E}a|7:primary",
      "v1|P1|7:sandbox|5:a|1:b|1:c|7:primary",
    ]);
  });
});

describe("v3 event and evidence identities (spec §5.5)", () => {
  it("scopes effect event IDs to the merchant", () => {
    expect(effectEventId(scope({ merchantId: "SYN-M-A" }))).not.toBe(effectEventId(scope({ merchantId: "SYN-M-B" })));
  });
  it("binds every §5.5 scope field into both event IDs", () => {
    const changes: Array<Partial<EventScope>> = [{ merchantId: "SYN-M-B" }, { authority: "PAYPAL" }, { payeeMerchantId: "SYN-PAYEE-2" },
      { obligationKey: key("SYN-PAYEE-1", "SYN-CAP-2") }, { eventKind: "fulfilment.dispatch" }, { contractVersion: "0.2.0" }];
    for (const change of changes) {
      expect(effectEventId(scope(change)), JSON.stringify(change)).not.toBe(effectEventId(scope()));
      expect(evidenceEventId({ ...scope(change), callId: "c" }), JSON.stringify(change)).not.toBe(evidenceEventId({ ...scope(), callId: "c" }));
    }
  });
  it("hashes only the named fields, so extra properties can't change or retag an ID", () => {
    const withExtras = { ...scope(), callId: "call-1", domain: "ordertruth.evidence-event.v3", note: "x" };
    expect(effectEventId(withExtras)).toBe(effectEventId(scope()));
    expect(effectEventId(withExtras)).not.toBe(evidenceEventId({ ...scope(), callId: "call-1" }));
    expect(evidenceEventId({ ...withExtras, callId: "call-1" })).toBe(evidenceEventId({ ...scope(), callId: "call-1" }));
  });
  it("makes effect event IDs deterministic", () => {
    expect(effectEventId(scope())).toBe(effectEventId(scope()));
    expect(effectEventId(scope())).toMatch(/^[0-9a-f]{64}$/);
  });
  it("gives each call its own evidence event ID, distinct from the effect event ID", () => {
    const a = evidenceEventId({ ...scope(), callId: "call-1" }), b = evidenceEventId({ ...scope(), callId: "call-2" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(effectEventId(scope()));
  });
  it("derives evidence IDs from authority, merchant, capture and observation", () => {
    const base = { authority: "TEST" as const, merchantId: "SYN-M-A", captureId: "SYN-CAP-1", observationHash: "obs-1" };
    expect(evidenceId(base)).toBe(evidenceId({ ...base }));
    for (const change of [{ authority: "PAYPAL" as const }, { merchantId: "SYN-M-B" }, { captureId: "SYN-CAP-2" }, { observationHash: "obs-2" }])
      expect(evidenceId({ ...base, ...change })).not.toBe(evidenceId(base));
    const withExtras = { ...base, callId: "call-1", domain: "x" };   // a variable, as runtime callers pass it, so no excess-property check applies
    expect(evidenceId(withExtras)).toBe(evidenceId(base));            // only the four named fields count
  });
});

describe("v3 fingerprints and input validation", () => {
  it("fingerprints independently of key order and changes with the amount", () => {
    const reordered = Object.fromEntries(Object.entries(fingerprintInput).reverse()) as P1FingerprintInput;
    expect(fingerprintP1(reordered)).toBe(fingerprintP1(fingerprintInput));
    expect(fingerprintP1({ ...fingerprintInput, amountMinor: "1001" })).not.toBe(fingerprintP1(fingerprintInput));
  });
  it("rejects non-canonical amount strings", () => {
    for (const ok of ["0", "1000", "1".repeat(18)]) expect(validateAmountMinor(ok), ok).toBe(true);
    for (const bad of ["01000", "10.00", 1000, "-1", "1".repeat(19), "", " 1", "1e3", null]) expect(validateAmountMinor(bad), String(bad)).toBe(false);
  });
  it("accepts identifiers of 1–128 code points and rejects empty, oversized, control or ill-formed ones", () => {
    expect(validateIdentifier("SYN-CAP-1")).toBe(true);
    expect(validateIdentifier("\u{1D11E}".repeat(128))).toBe(true);
    for (const bad of ["", "a".repeat(129), "\u{1D11E}".repeat(129), "a\u0000", "a\u001F", "a\u0085", "\uD800", 42, undefined])
      expect(validateIdentifier(bad), JSON.stringify(bad)).toBe(false);
  });
});
