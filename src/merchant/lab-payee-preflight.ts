/** Offline-compatible schema/identity preflight. Never performs a request or accepts an email fallback. */
export function preflightPayee(raw: unknown, expectedMerchantId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(expectedMerchantId)) throw new Error("invalid expected payee");
  const units=raw && typeof raw === "object" ? (raw as {purchase_units?:unknown}).purchase_units : undefined;
  if (!Array.isArray(units) || units.length !== 1 || !units[0] || typeof units[0] !== "object") return {eligible:false,reason:"PURCHASE_UNIT_SHAPE"} as const;
  const owner=(units[0] as {payee?:unknown}).payee;
  const payee=owner && typeof owner === "object" ? (owner as {merchant_id?:unknown}).merchant_id : undefined;
  if (typeof payee !== "string" || !payee) return {eligible:false,reason:"PAYEE_MERCHANT_ID_MISSING"} as const;
  if (payee !== expectedMerchantId) return {eligible:false,reason:"PAYEE_MERCHANT_ID_MISMATCH"} as const;
  return {eligible:true,reason:"PAYEE_MERCHANT_ID_MATCH"} as const;
}
