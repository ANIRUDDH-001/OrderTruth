/**
 * Redaction for anything that may reach logs, evidence files, the DB or the browser.
 * Two layers: exact known secret values, and generic credential-shaped patterns.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/Basic\s+[A-Za-z0-9+/=]{8,}/gi, "Basic [REDACTED]"],
  [/("?(?:access_token|refresh_token|id_token|client_secret|nonce|api[_-]?key)"?\s*[:=]\s*"?)[^"&,\s}]+/gi, "$1[REDACTED]"],
  [/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_GOOGLE_KEY]"],
  [/A21AA[0-9A-Za-z_-]{20,}/g, "[REDACTED_PAYPAL_TOKEN]"],
  [/([?&]key=)[^&\s]+/gi, "$1[REDACTED]"],
];

export function redactString(input: string, secrets: readonly string[] = []): string {
  let out = input;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

const SENSITIVE_KEYS = /^(authorization|access_token|refresh_token|id_token|client_secret|secret|password|api_?key|x-goog-api-key|token|nonce)$/i;
/** Buyer identity fields: never persisted in evidence. */
const PII_KEYS = /^(email_address|payer|name|given_name|surname|phone|phone_number|address|address_line_1|address_line_2|postal_code|birth_date|tax_info)$/i;

/** Deep-redact an object: removes credentials and buyer PII by key, then scrubs strings. */
export function redactValue(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 12) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.test(k)) out[k] = "[REDACTED]";
      else if (PII_KEYS.test(k)) out[k] = "[PII_REMOVED]";
      else out[k] = redactValue(v, secrets, depth + 1);
    }
    return out;
  }
  return value;
}

/** Show only enough of an identifier to correlate, e.g. merchant IDs. */
export function maskId(id: string | undefined | null): string | null {
  if (!id) return null;
  if (id.length <= 6) return "***";
  return `${id.slice(0, 3)}…${id.slice(-3)}`;
}
