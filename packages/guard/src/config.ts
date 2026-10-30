/**
 * Trusted registered statements (spec §5.3a). Registered SQL is trusted integration configuration; this check is a
 * conservative lexical guard against configuration mistakes, not proof that a statement is semantically correct
 * (the verifier's observer checks persisted state independently). Anything it cannot classify is rejected.
 */
export type RegisteredStatement = { sql: string; params: string[]; returns: string[] };
export type GuardConfig = { createOrder: RegisteredStatement; orderLocator: RegisteredStatement; intentLocator: RegisteredStatement;
  singleTenantMerchantSchema: boolean; sites: Array<{ siteId: string; pathId: string }> };
export const REQUIRED_CREATE_ORDER_RETURNS = ["id", "intent_id", "paypal_order_id", "capture_id", "amount_minor", "currency"] as const;
export type ConfigErrorCode = "MULTIPLE_STATEMENTS" | "TRANSACTION_CONTROL" | "DATA_MODIFYING_CTE" | "RETURNS_MISSING_IDENTITY" | "MERCHANT_PARAM_MISSING" | "UNCLASSIFIABLE";
export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  constructor(code: ConfigErrorCode, message: string) { super(message); this.code = code; this.name = "ConfigError"; }
}

const ALLOWED_PARAMS = new Set(["merchant.id", "intent.id", "capture.id", "capture.paypalOrderId", "capture.amountMinor", "capture.currency", "order.id", "path.id", "site.id"]);
const TRANSACTION_WORDS = new Set(["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE"]);
const TRANSACTION_LEADERS = new Set(["START", "END", "ABORT", "PREPARE"]);
const DML = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);

/** Replaces each single-quoted literal with '' and each quoted identifier with "q", so their contents can't be misread. */
function stripLiterals(name: string, sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length;) {
    const c = sql[i]!;
    if (c === "'") {
      // A quote glued to an identifier character is a prefixed string (E'', U&'', B'', X''): not classified here.
      if (/[A-Za-z0-9_&]$/.test(out)) throw new ConfigError("UNCLASSIFIABLE", `${name}: prefixed string literal`);
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new ConfigError("UNCLASSIFIABLE", `${name}: unterminated literal`);
        // Backslashes change literal boundaries when standard_conforming_strings is off: never depend on that setting.
        if (sql[j] === "\\") throw new ConfigError("UNCLASSIFIABLE", `${name}: backslash inside a literal`);
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      out += "''"; i = j + 1; continue;
    }
    if (c === '"') {
      const j = sql.indexOf('"', i + 1);
      if (j < 0) throw new ConfigError("UNCLASSIFIABLE", `${name}: unterminated quoted identifier`);
      out += '"q"'; i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

function checkStatement(name: string, s: RegisteredStatement, kind: "INSERT" | "SELECT"): void {
  const text = stripLiterals(name, s.sql);
  // Any $ that doesn't start a numeric placeholder ($$, $tag$ with any characters, $x) and any comment is unclassifiable.
  if (/\$(?!\d)|--|\/\*/.test(text)) throw new ConfigError("UNCLASSIFIABLE", `${name}: dollar quoting, stray $ or comments`);
  if (text.trim().replace(/;\s*$/, "").includes(";")) throw new ConfigError("MULTIPLE_STATEMENTS", `${name}: more than one statement`);
  const tokens = text.match(/[A-Za-z_][A-Za-z0-9_]*|[()]/g) ?? [];
  const words = tokens.filter(t => t !== "(" && t !== ")").map(t => t.toUpperCase());
  if (words.some(w => TRANSACTION_WORDS.has(w)) || TRANSACTION_LEADERS.has(words[0] ?? ""))
    throw new ConfigError("TRANSACTION_CONTROL", `${name}: transaction control`);
  let depth = 0;
  for (const token of tokens) {
    if (token === "(") depth++;
    else if (token === ")") depth--;
    else if (depth > 0 && DML.has(token.toUpperCase()))
      throw new ConfigError(words[0] === "WITH" ? "DATA_MODIFYING_CTE" : "UNCLASSIFIABLE", `${name}: data-modifying subquery`);
  }
  if (depth !== 0) throw new ConfigError("UNCLASSIFIABLE", `${name}: unbalanced parentheses`);
  if (words[0] !== kind) throw new ConfigError("UNCLASSIFIABLE", `${name}: must be a single ${kind}`);
  // An upsert (ON CONFLICT … DO UPDATE) could overwrite an existing order instead of creating one.
  if (kind === "INSERT" && words.some((w, i) => w === "DO" && words[i + 1] === "UPDATE"))
    throw new ConfigError("UNCLASSIFIABLE", `${name}: ON CONFLICT DO UPDATE is not allowed`);
  const unknown = s.params.filter(p => !ALLOWED_PARAMS.has(p));
  if (unknown.length) throw new ConfigError("UNCLASSIFIABLE", `${name}: unknown parameter ${unknown.join(", ")}`);
  const used = new Set([...text.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  const expected = new Set(s.params.map((_p, i) => i + 1));
  if (used.size !== expected.size || [...expected].some(n => !used.has(n)))
    throw new ConfigError("UNCLASSIFIABLE", `${name}: placeholders must be exactly $1..$${s.params.length}`);
}

export function validateConfig(c: GuardConfig): void {
  checkStatement("createOrder", c.createOrder, "INSERT");
  checkStatement("orderLocator", c.orderLocator, "SELECT");
  checkStatement("intentLocator", c.intentLocator, "SELECT");
  for (const [name, s] of [["createOrder", c.createOrder], ["orderLocator", c.orderLocator]] as const) {
    const missing = REQUIRED_CREATE_ORDER_RETURNS.filter(col => !s.returns.includes(col));
    if (missing.length) throw new ConfigError("RETURNS_MISSING_IDENTITY", `${name}: returns lacks ${missing.join(", ")}`);
  }
  if (!c.singleTenantMerchantSchema)
    for (const [name, s] of [["createOrder", c.createOrder], ["orderLocator", c.orderLocator], ["intentLocator", c.intentLocator]] as const)
      if (!s.params.includes("merchant.id")) throw new ConfigError("MERCHANT_PARAM_MISSING", `${name}: multi-tenant schema requires merchant.id`);
}
