/**
 * The Gate A lab merchant's own schema (plan Task 8; trusted, manifest-pinned). shop.orders deliberately has NO unique key
 * on intent_id: that is REF-BUG-1's precondition. shop.processed_events is an ordinary webhook-dedup table (NC1 misuses it).
 */
export const SHOP_SCHEMA_SQL = `
CREATE SCHEMA shop;
CREATE TABLE shop.intents (id text PRIMARY KEY, sku text NOT NULL, currency text NOT NULL, amount_minor bigint NOT NULL, line_items jsonb NOT NULL);
CREATE TABLE shop.orders (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, intent_id text NOT NULL, paypal_order_id text NOT NULL,
  capture_id text NOT NULL, amount_minor bigint NOT NULL, currency text NOT NULL, created_by_path text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE shop.processed_events (event_id text PRIMARY KEY, processed_at timestamptz NOT NULL DEFAULT now());`;

/** The fixture intents (SYN- only), matching packages/guard/fixtures/synthetic-fixture.json. */
export const SHOP_INTENTS_SQL = `
INSERT INTO shop.intents VALUES
  ('SYN-INT-1', 'SKU-1', 'USD', 1000, '[{"sku":"SKU-1","qty":1}]'),
  ('SYN-INT-2', 'SKU-2', 'USD', 2500, '[{"sku":"SKU-2","qty":1}]'),
  ('SYN-INT-3', 'SKU-3', 'EUR', 990,  '[{"sku":"SKU-3","qty":1}]');`;
