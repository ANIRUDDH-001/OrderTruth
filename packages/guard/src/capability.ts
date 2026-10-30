/**
 * Capture capabilities (spec §6, §6.1). A capability is an in-process proof that a capture was verified and its evidence
 * committed. The HMAC guards against developer mistakes and in-process forgery, not against a compromised merchant
 * server; the authority name is inside the MAC, so neither authority's key validates the other's capabilities.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonical, sha256 } from "../../../src/domain/canonical.ts";
import { runGuardTx, type Confirm, type GuardPools, type RunHooks } from "./commit.ts";
import { CONTRACT, evidenceId, obligationKeyP1, validateAmountMinor, validateIdentifier } from "./identity.ts";

export type CaptureCapability = { authority: "PAYPAL" | "TEST"; provenance: "PAYPAL_READBACK" | "SYNTHETIC_FIXTURE"; merchantId: string;
  paypalEnv: "sandbox"; payeeMerchantId: string; paypalOrderId: string; captureId: string; status: "COMPLETED";
  currency: string; amountMinor: string; intentId: string; verificationMethod: "READBACK" | "FIXTURE";
  observedAt: string; responseHash: string; evidenceId: string; mac: string };

type Unsigned = Omit<CaptureCapability, "mac">;
/** Exactly the capability fields, picked by name, so extra properties can't affect the MAC. */
const signedFields = (c: Unsigned): Unsigned => ({ authority: c.authority, provenance: c.provenance, merchantId: c.merchantId, paypalEnv: c.paypalEnv,
  payeeMerchantId: c.payeeMerchantId, paypalOrderId: c.paypalOrderId, captureId: c.captureId, status: c.status, currency: c.currency,
  amountMinor: c.amountMinor, intentId: c.intentId, verificationMethod: c.verificationMethod, observedAt: c.observedAt,
  responseHash: c.responseHash, evidenceId: c.evidenceId });
const mac = (c: Unsigned, key: Buffer) => createHmac("sha256", key).update(canonical({ domain: "ordertruth.capability.v3", ...signedFields(c) })).digest("hex");

/** One read of every capability field, so getters or later mutation can't change what was checked (review CP2 NB1). */
export function snapshotCapability(c: CaptureCapability): CaptureCapability {
  return { ...signedFields(c), mac: c.mac };
}

export function signCapability(c: Unsigned, key: Buffer): CaptureCapability {
  return { ...signedFields(c), mac: mac(c, key) };
}

export type Observation = Omit<CaptureCapability, "mac" | "evidenceId"> & { observationHash: string };

export const SDK_VERSION = "0.1.0-gate-a";
/** One capture.observed event per evidence record, so repeated issuance never duplicates it. */
export const observationEventId = (merchantId: string, evidence: string) =>
  sha256(canonical({ domain: "ordertruth.capture-observed.v3", merchantId, evidenceId: evidence }));

function validateObservation(o: Observation): void {
  for (const k of ["merchantId", "payeeMerchantId", "paypalOrderId", "captureId", "intentId"] as const)
    if (!validateIdentifier(o[k])) throw new Error(`issueCapability: invalid ${k}`);
  if (!validateAmountMinor(o.amountMinor)) throw new Error("issueCapability: invalid amountMinor");
  if (o.paypalEnv !== "sandbox") throw new Error("issueCapability: sandbox only");
  if (o.status !== "COMPLETED") throw new Error("issueCapability: only COMPLETED captures are fulfilment-grade");
  const pair = `${o.authority}/${o.provenance}/${o.verificationMethod}`;
  if (pair !== "TEST/SYNTHETIC_FIXTURE/FIXTURE" && pair !== "PAYPAL/PAYPAL_READBACK/READBACK") throw new Error(`issueCapability: inconsistent authority ${pair}`);
  if (Number.isNaN(Date.parse(o.observedAt))) throw new Error("issueCapability: invalid observedAt");
}

/** ISSUANCE confirmation (plan Task 5 table): the evidence row, its capture.observed event and its delivery row all exist. */
export const confirmIssuance: Confirm = async (r, aux) => {
  if (r.outcome !== "ISSUED" || typeof r.evidenceId !== "string" || typeof r.observationEventId !== "string" || typeof r.merchantId !== "string") return false;
  if (r.observationEventId !== observationEventId(r.merchantId, r.evidenceId)) return false;
  const q = await aux.query(`SELECT
      EXISTS (SELECT 1 FROM ordertruth_guard.capture_evidence WHERE evidence_id = $1 AND merchant_id = $3) AS evidence,
      EXISTS (SELECT 1 FROM ordertruth_guard.outbox WHERE event_id = $2 AND kind = 'capture.observed' AND merchant_id = $3) AS event,
      EXISTS (SELECT 1 FROM ordertruth_guard.outbox_deliveries WHERE event_id = $2 AND destination = 'cloud_evidence') AS delivery`,
    [r.evidenceId, r.observationEventId, r.merchantId]);
  const row = q.rows[0] as { evidence: boolean; event: boolean; delivery: boolean } | undefined;
  return !!row && row.evidence && row.event && row.delivery;
};

/**
 * The one issuance path for both authorities (spec §6.1 item 4): commits the capture evidence, its capture.observed event
 * and that event's delivery row, and only then returns a signed capability. Fails closed: no commit, no capability.
 */
export async function issueCapability(pools: GuardPools, o: Observation, key: Buffer,
  meta: { buildId?: string; hooks?: RunHooks } = {}): Promise<CaptureCapability> {
  validateObservation(o);
  const evidence = evidenceId({ authority: o.authority, merchantId: o.merchantId, captureId: o.captureId, observationHash: o.observationHash });
  const eventId = observationEventId(o.merchantId, evidence), buildId = meta.buildId ?? "unspecified";
  await runGuardTx(pools, "ISSUANCE", { merchantId: o.merchantId, evidenceId: evidence, captureId: o.captureId }, async (tx, { callId }) => {
    await tx.query(`INSERT INTO ordertruth_guard.capture_evidence (evidence_id, merchant_id, authority, provenance, paypal_env, payee_merchant_id, paypal_order_id,
        capture_id, intent_id, status, currency, amount_minor, verification_method, observed_at, response_hash, observation_hash, contract_version, sdk_version, build_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::bigint,$13,$14::timestamptz,$15,$16,$17,$18,$19) ON CONFLICT (evidence_id) DO NOTHING`,
      [evidence, o.merchantId, o.authority, o.provenance, o.paypalEnv, o.payeeMerchantId, o.paypalOrderId, o.captureId, o.intentId, o.status,
        o.currency, o.amountMinor, o.verificationMethod, o.observedAt, o.responseHash, o.observationHash, CONTRACT.version, SDK_VERSION, buildId]);
    // Every field, so a capability is never issued for a stored row that would later fail the claim-time comparison.
    const stored = (await tx.query(`SELECT merchant_id, authority, provenance, paypal_env, payee_merchant_id, paypal_order_id, capture_id, intent_id, status, currency,
        amount_minor::text AS amount_minor, verification_method, response_hash, observation_hash, observed_at = $2::timestamptz AS observed_at_equal
      FROM ordertruth_guard.capture_evidence WHERE evidence_id = $1`, [evidence, o.observedAt])).rows[0] as Record<string, unknown> | undefined;
    const expected: Record<string, unknown> = { merchant_id: o.merchantId, authority: o.authority, provenance: o.provenance, paypal_env: o.paypalEnv,
      payee_merchant_id: o.payeeMerchantId, paypal_order_id: o.paypalOrderId, capture_id: o.captureId, intent_id: o.intentId, status: o.status, currency: o.currency,
      amount_minor: o.amountMinor, verification_method: o.verificationMethod, response_hash: o.responseHash, observation_hash: o.observationHash, observed_at_equal: true };
    if (!stored || Object.keys(expected).some(k => stored[k] !== expected[k]))
      throw new Error("issueCapability: an existing evidence record with this ID holds different data");
    const obligationKey = obligationKeyP1({ paypalEnv: "sandbox", payeeMerchantId: o.payeeMerchantId, captureId: o.captureId, unit: "primary" });
    await tx.query(`INSERT INTO ordertruth_guard.outbox (event_id, merchant_id, kind, obligation_key, call_id, payload, authority, provenance, contract_version, sdk_version, build_id)
      VALUES ($1,$2,'capture.observed',$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (event_id) DO NOTHING`,
      [eventId, o.merchantId, obligationKey, callId, JSON.stringify({ evidenceId: evidence, captureId: o.captureId }), o.authority, o.provenance, CONTRACT.version, SDK_VERSION, buildId]);
    await tx.query(`INSERT INTO ordertruth_guard.outbox_deliveries (event_id, destination, merchant_id) VALUES ($1, 'cloud_evidence', $2)
      ON CONFLICT (event_id, destination) DO NOTHING`, [eventId, o.merchantId]);
    return { value: evidence, outcomeRecord: { callId, boundary: "ISSUANCE", merchantId: o.merchantId, outcome: "ISSUED", evidenceId: evidence, observationEventId: eventId } };
  }, { confirm: confirmIssuance, ...(meta.hooks ? { hooks: meta.hooks } : {}) });
  const { observationHash: _hash, ...fields } = o;
  return signCapability({ ...fields, evidenceId: evidence }, key);
}

export function verifyMac(c: CaptureCapability, key: Buffer): boolean {
  if (typeof c.mac !== "string" || !/^[0-9a-f]{64}$/.test(c.mac)) return false;
  return timingSafeEqual(Buffer.from(mac(c, key), "hex"), Buffer.from(c.mac, "hex"));
}
