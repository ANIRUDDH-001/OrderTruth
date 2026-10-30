/**
 * OrderTruth v3 obligation identities (spec §5.2a, §5.5). The obligation key must equal the database's generated
 * `obligation_key` column byte for byte (packages/guard/sql/guard-v1.sql); event and evidence IDs are tenant-scoped
 * canonical hashes with domain separation, never concatenated strings.
 */
import { canonical, sha256 } from "../../../src/domain/canonical.ts";

export const CONTRACT = { id: "OT_V3_OBLIGATION", version: "0.1.0" } as const;
export const KEY_VERSION = 1;

export type P1Key = { paypalEnv: "sandbox"; payeeMerchantId: string; captureId: string; unit: "primary" };
/** PostgreSQL's length() counts characters (code points) in UTF-8, so the TypeScript side must too. */
const codePoints = (s: string) => [...s].length;
const framed = (part: string) => `${codePoints(part)}:${part}`;

/** Throws rather than produce a key the database would store differently (e.g. a lone surrogate sent as U+FFFD). */
export function obligationKeyP1(k: P1Key, keyVersion = KEY_VERSION): string {
  if (keyVersion !== KEY_VERSION) throw new Error(`obligationKeyP1: unsupported key version ${keyVersion}`);
  if (k.paypalEnv !== "sandbox") throw new Error("obligationKeyP1: paypalEnv must be sandbox");
  if (k.unit !== "primary") throw new Error("obligationKeyP1: unit must be primary");
  if (!validateIdentifier(k.payeeMerchantId) || !validateIdentifier(k.captureId)) throw new Error("obligationKeyP1: invalid payee or capture identifier");
  return `v${keyVersion}|P1|${[k.paypalEnv, k.payeeMerchantId, k.captureId, k.unit].map(framed).join("|")}`;
}

export type P1FingerprintInput = { captureId: string; paypalOrderId: string; intentId: string; currency: string; amountMinor: string; linesHash: string };
export function fingerprintP1(i: P1FingerprintInput): string {
  return sha256(canonical(i));
}

export type EventScope = { merchantId: string; authority: "PAYPAL" | "TEST"; paypalEnv: "sandbox"; payeeMerchantId: string;
  operationKind: "CREATE_ORDER"; obligationKey: string; eventKind: string; contractVersion: string };
/** Exactly the §5.5 fields, picked by name: extra properties on the argument can neither change nor retag an ID. */
const scopeFields = (s: EventScope) => ({ merchantId: s.merchantId, authority: s.authority, paypalEnv: s.paypalEnv, payeeMerchantId: s.payeeMerchantId,
  operationKind: s.operationKind, obligationKey: s.obligationKey, eventKind: s.eventKind, contractVersion: s.contractVersion });
export function effectEventId(s: EventScope): string {
  return sha256(canonical({ ...scopeFields(s), domain: "ordertruth.effect-event.v3" }));
}
export function evidenceEventId(s: EventScope & { callId: string }): string {
  return sha256(canonical({ ...scopeFields(s), callId: s.callId, domain: "ordertruth.evidence-event.v3" }));
}
/** The four named fields only (spec §5.3e), so extra properties on the argument can't change the evidence ID. */
export function evidenceId(a: { authority: "PAYPAL" | "TEST"; merchantId: string; captureId: string; observationHash: string }): string {
  return sha256(canonical({ authority: a.authority, merchantId: a.merchantId, captureId: a.captureId, observationHash: a.observationHash }));
}

/** C0 and C1 control characters, including DEL. */
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
/** A high surrogate not followed by a low one, or a low surrogate not preceded by a high one (lib ES2023 has no isWellFormed). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** 1–128 code points, well-formed UTF-16 (no lone surrogates PostgreSQL would reject), no control characters. */
export function validateIdentifier(v: unknown): v is string {
  return typeof v === "string" && !LONE_SURROGATE.test(v) && !CONTROL.test(v) && codePoints(v) >= 1 && codePoints(v) <= 128;
}
/** Integer minor units as a canonical decimal string: no sign, no leading zeros, at most 18 digits. */
export function validateAmountMinor(v: unknown): v is string {
  return typeof v === "string" && /^(0|[1-9][0-9]{0,17})$/.test(v);
}
