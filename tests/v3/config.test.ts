import { describe, expect, it } from "vitest";
import { ConfigError, REQUIRED_CREATE_ORDER_RETURNS, validateConfig, type GuardConfig, type RegisteredStatement } from "../../packages/guard/src/config.ts";

const IDENTITY = [...REQUIRED_CREATE_ORDER_RETURNS];
/** The V-A trusted configuration (Task 8 reuses this literal in packages/lab-merchant/src/v-a/ordertruth.config.ts). */
const V_A: GuardConfig = {
  createOrder: {
    sql: "INSERT INTO shop.orders (intent_id, paypal_order_id, capture_id, amount_minor, currency, created_by_path) VALUES ($1, $2, $3, $4, $5, $6) "
      + "RETURNING id, intent_id, paypal_order_id, capture_id, amount_minor::text AS amount_minor, currency",
    params: ["intent.id", "capture.paypalOrderId", "capture.id", "capture.amountMinor", "capture.currency", "path.id"], returns: IDENTITY },
  orderLocator: {
    sql: "SELECT id, intent_id, paypal_order_id, capture_id, amount_minor::text AS amount_minor, currency FROM shop.orders WHERE id = $1",
    params: ["order.id"], returns: IDENTITY },
  intentLocator: {
    sql: "SELECT id, sku, currency, amount_minor::text AS amount_minor, line_items FROM shop.intents WHERE id = $1",
    params: ["intent.id"], returns: ["id", "sku", "currency", "amount_minor", "line_items"] },
  singleTenantMerchantSchema: true,
  sites: [{ siteId: "checkout_return:order-write", pathId: "checkout_return" }, { siteId: "webhook:order-write", pathId: "webhook" }],
};
const withCreate = (over: Partial<RegisteredStatement>): GuardConfig => ({ ...V_A, createOrder: { ...V_A.createOrder, ...over } });
const codeOf = (config: GuardConfig) => { try { validateConfig(config); return "OK"; } catch (error) { return error instanceof ConfigError ? error.code : `NOT_CONFIG_ERROR: ${String(error)}`; } };

describe("registered-statement validation (spec §5.3a)", () => {
  it("accepts the V-A trusted configuration", () => {
    expect(codeOf(V_A)).toBe("OK");
  });
  it.each([
    ["a second statement after ;", withCreate({ sql: `${V_A.createOrder.sql}; DELETE FROM shop.orders` }), "MULTIPLE_STATEMENTS"],
    ["transaction control", withCreate({ sql: "COMMIT", params: [] }), "TRANSACTION_CONTROL"],
    ["a savepoint", withCreate({ sql: "SAVEPOINT s1", params: [] }), "TRANSACTION_CONTROL"],
    ["a data-modifying CTE", withCreate({ sql: `WITH gone AS (DELETE FROM shop.orders RETURNING id) ${V_A.createOrder.sql}` }), "DATA_MODIFYING_CTE"],
    ["returns missing capture_id", withCreate({ returns: IDENTITY.filter(c => c !== "capture_id") }), "RETURNS_MISSING_IDENTITY"],
    ["an order locator missing an identity column", { ...V_A, orderLocator: { ...V_A.orderLocator, returns: ["id"] } }, "RETURNS_MISSING_IDENTITY"],
    ["a multi-tenant schema without merchant.id", { ...V_A, singleTenantMerchantSchema: false }, "MERCHANT_PARAM_MISSING"],
    ["dollar quoting", withCreate({ sql: `${V_A.createOrder.sql} $$x$$` }), "UNCLASSIFIABLE"],
    ["a line comment", withCreate({ sql: `${V_A.createOrder.sql} -- note` }), "UNCLASSIFIABLE"],
    ["a block comment", withCreate({ sql: `${V_A.createOrder.sql} /* note */` }), "UNCLASSIFIABLE"],
    ["an E'' escape string", withCreate({ sql: V_A.createOrder.sql.replace("$6)", "E'x')"), params: V_A.createOrder.params.slice(0, 5) }), "UNCLASSIFIABLE"],
    ["an unknown parameter name", withCreate({ params: [...V_A.createOrder.params.slice(0, 5), "request.body"] }), "UNCLASSIFIABLE"],
    ["placeholders that don't match params", withCreate({ params: V_A.createOrder.params.slice(0, 5) }), "UNCLASSIFIABLE"],
    ["createOrder that isn't an INSERT", withCreate({ sql: "UPDATE shop.orders SET currency = $1 RETURNING id", params: ["capture.currency"] }), "UNCLASSIFIABLE"],
    // Zero numeric placeholders, so only the dollar-quote rule can reject it (review B1's exact shape).
    ["a non-ASCII dollar-quote tag hiding a second statement (review B1)",
      withCreate({ sql: "INSERT INTO shop.orders (intent_id) VALUES ('x') RETURNING id, intent_id, paypal_order_id, capture_id, amount_minor, $é$'$é$; "
        + "DELETE FROM shop.orders; SELECT $é$'$é$ AS currency", params: [] }), "UNCLASSIFIABLE"],
    ["a bare $ that isn't a placeholder", withCreate({ sql: `${V_A.createOrder.sql}, $x AS extra` }), "UNCLASSIFIABLE"],
    // Well-formed under standard_conforming_strings=on; rejected so the guard never depends on that setting.
    ["a backslash inside a literal", withCreate({ sql: V_A.createOrder.sql.replace("$6)", "'a\\b')"), params: V_A.createOrder.params.slice(0, 5) }), "UNCLASSIFIABLE"],
    ["an upsert that could overwrite an existing order", withCreate({ sql: V_A.createOrder.sql.replace(" RETURNING", " ON CONFLICT (id) DO UPDATE SET currency = EXCLUDED.currency RETURNING") }), "UNCLASSIFIABLE"],
    ["a locator that isn't a SELECT", { ...V_A, orderLocator: { ...V_A.orderLocator, sql: "DELETE FROM shop.orders WHERE id = $1 RETURNING id" } }, "UNCLASSIFIABLE"],
  ])("rejects %s", (_name, config, code) => {
    expect(codeOf(config as GuardConfig)).toBe(code);
  });
  it("does not misread ; or -- inside a single-quoted literal", () => {
    const sql = V_A.createOrder.sql.replace("$6)", "'checkout;--return')");
    expect(codeOf(withCreate({ sql, params: V_A.createOrder.params.slice(0, 5) }))).toBe("OK");
  });
  it("accepts a multi-tenant schema whose statements all take merchant.id", () => {
    const config: GuardConfig = { ...V_A, singleTenantMerchantSchema: false,
      createOrder: { sql: "INSERT INTO shop.orders (merchant_id, intent_id, paypal_order_id, capture_id, amount_minor, currency, created_by_path) "
        + "VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, intent_id, paypal_order_id, capture_id, amount_minor::text AS amount_minor, currency",
        params: ["merchant.id", ...V_A.createOrder.params], returns: IDENTITY },
      orderLocator: { sql: "SELECT id, intent_id, paypal_order_id, capture_id, amount_minor::text AS amount_minor, currency FROM shop.orders WHERE merchant_id = $1 AND id = $2",
        params: ["merchant.id", "order.id"], returns: IDENTITY },
      intentLocator: { sql: "SELECT id, sku, currency, amount_minor::text AS amount_minor, line_items FROM shop.intents WHERE merchant_id = $1 AND id = $2",
        params: ["merchant.id", "intent.id"], returns: V_A.intentLocator.returns } };
    expect(codeOf(config)).toBe("OK");
  });
  it("does not mistake a literal ending in E for an E'' escape string", () => {
    const sql = V_A.createOrder.sql.replace("$6)", "'COFFEE')");
    expect(codeOf(withCreate({ sql, params: V_A.createOrder.params.slice(0, 5) }))).toBe("OK");
  });
  it("rejects an unterminated literal", () => {
    expect(codeOf(withCreate({ sql: V_A.createOrder.sql.replace("$6)", "'open)"), params: V_A.createOrder.params.slice(0, 5) }))).toBe("UNCLASSIFIABLE");
  });
});
