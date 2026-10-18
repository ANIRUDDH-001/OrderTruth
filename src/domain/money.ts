/** Integer minor units only. Gate 0 supports USD (2 decimal places). */
export type Currency = "USD";
export const CURRENCY_DECIMALS: Record<Currency, number> = { USD: 2 };

export type Money = { currency: Currency; minor: number };

export function toProviderValue(m: Money): string {
  if (!Number.isSafeInteger(m.minor) || m.minor < 0) throw new Error("amount must be a non-negative safe integer");
  const d = CURRENCY_DECIMALS[m.currency];
  const s = String(m.minor).padStart(d + 1, "0");
  return `${s.slice(0, -d)}.${s.slice(-d)}`;
}

/** Strictly parse a provider decimal string into minor units; rejects floats-as-numbers and extra precision. */
export function parseProviderValue(value: unknown, currency: string): Money | null {
  if (currency !== "USD" || typeof value !== "string") return null;
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0"));
  return { currency: "USD", minor: whole * 100 + frac };
}
