-- OrderTruth v3 guard migration v1 (Gate A: profile P1 / CREATE_ORDER only).
-- Spec: docs/superpowers/specs/2026-10-30-ordertruth-obligation-integrity-design.md §5.1, §5.2a, §5.3e.
-- Applied to a MERCHANT database, never the OrderTruth cloud database (which owns schema "ordertruth").
-- Requires a UTF8 database: the generated key relies on length() counting code points (checked by migrateGuard).
-- Idempotent. Integer lengths are cast explicitly (length(x)::text) so the generated key uses only
-- immutable expressions, as PostgreSQL requires for generated columns.
--
-- Deviation from §5.2a, recorded for Gate A: the spec's shared-profile layout keeps identity columns nullable and
-- enforces presence per profile with CHECKs. This P1-only migration declares them NOT NULL instead (stricter and
-- equivalent for CREATE_ORDER; a missing value raises 23502, not 23514). Adding MARK_PAID needs a v2 migration that
-- relaxes NOT NULL into the spec's per-profile CHECKs and extends the generated expression.

CREATE SCHEMA IF NOT EXISTS ordertruth_guard;

-- One merchant tenant per merchant database.
CREATE TABLE IF NOT EXISTS ordertruth_guard.installation (
  singleton       boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  merchant_id     text NOT NULL,
  schema_version  smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ordertruth_guard.obligations (
  merchant_id         text NOT NULL CHECK (length(merchant_id) BETWEEN 1 AND 128),
  operation_kind      text NOT NULL CHECK (operation_kind IN ('CREATE_ORDER')),
  paypal_env          text NOT NULL CHECK (paypal_env = 'sandbox'),
  payee_merchant_id   text NOT NULL CHECK (length(payee_merchant_id) BETWEEN 1 AND 128),
  capture_id          text NOT NULL CHECK (length(capture_id) BETWEEN 1 AND 128),
  intent_id           text NOT NULL CHECK (length(intent_id) BETWEEN 1 AND 128),
  unit                text NOT NULL DEFAULT 'primary' CHECK (unit = 'primary'),
  key_version         smallint NOT NULL DEFAULT 1 CHECK (key_version = 1),
  obligation_key      text GENERATED ALWAYS AS (
    'v' || key_version::text || '|P1|'
      || length(paypal_env)::text || ':' || paypal_env || '|'
      || length(payee_merchant_id)::text || ':' || payee_merchant_id || '|'
      || length(capture_id)::text || ':' || capture_id || '|'
      || length(unit)::text || ':' || unit
  ) STORED,
  claimed_by_call_id  text NOT NULL,
  origin              text NOT NULL CHECK (origin IN ('NEW')),
  fingerprint         text NOT NULL,
  result_table        text,
  result_id           text,
  authority           text NOT NULL CHECK (authority IN ('PAYPAL','TEST')),
  provenance          text NOT NULL,
  contract_version    text NOT NULL,
  sdk_version         text NOT NULL,
  path_id             text NOT NULL,
  site_id             text NOT NULL,
  build_id            text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, operation_kind, obligation_key)
);

-- P1: one intent can't get orders from two captures.
CREATE UNIQUE INDEX IF NOT EXISTS obligations_p1_intent
  ON ordertruth_guard.obligations (merchant_id, intent_id, unit)
  WHERE operation_kind = 'CREATE_ORDER';

-- Committed when a capability is issued (§6); compared field by field at claim time (§5.3c step 5).
CREATE TABLE IF NOT EXISTS ordertruth_guard.capture_evidence (
  evidence_id          text PRIMARY KEY,
  merchant_id          text NOT NULL CHECK (length(merchant_id) BETWEEN 1 AND 128),
  authority            text NOT NULL CHECK (authority IN ('PAYPAL','TEST')),
  provenance           text NOT NULL,
  paypal_env           text NOT NULL CHECK (paypal_env = 'sandbox'),
  payee_merchant_id    text NOT NULL CHECK (length(payee_merchant_id) BETWEEN 1 AND 128),
  paypal_order_id      text NOT NULL CHECK (length(paypal_order_id) BETWEEN 1 AND 128),
  capture_id           text NOT NULL CHECK (length(capture_id) BETWEEN 1 AND 128),
  intent_id            text NOT NULL CHECK (length(intent_id) BETWEEN 1 AND 128),
  status               text NOT NULL CHECK (status = 'COMPLETED'),
  currency             text NOT NULL,
  amount_minor         bigint NOT NULL CHECK (amount_minor >= 0),
  verification_method  text NOT NULL,
  observed_at          timestamptz NOT NULL,
  response_hash        text NOT NULL,
  observation_hash     text NOT NULL,
  contract_version     text NOT NULL,
  sdk_version          text NOT NULL,
  build_id             text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ordertruth_guard.outbox (
  event_id          text PRIMARY KEY,
  merchant_id       text NOT NULL CHECK (length(merchant_id) BETWEEN 1 AND 128),
  kind              text NOT NULL,
  obligation_key    text,
  call_id           text,
  payload           jsonb NOT NULL,
  authority         text NOT NULL CHECK (authority IN ('PAYPAL','TEST')),
  provenance        text NOT NULL,
  contract_version  text NOT NULL,
  sdk_version       text NOT NULL,
  path_id           text,
  build_id          text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ordertruth_guard.outbox_deliveries (
  event_id         text NOT NULL REFERENCES ordertruth_guard.outbox (event_id),
  destination      text NOT NULL,
  merchant_id      text NOT NULL CHECK (length(merchant_id) BETWEEN 1 AND 128),
  state            text NOT NULL DEFAULT 'PENDING'
                     CHECK (state IN ('PENDING','LEASED','DELIVERED','RETRY','POISONED','CONFLICT')),
  attempts         integer NOT NULL DEFAULT 0,
  lease_until      timestamptz,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  acked_at         timestamptz,
  last_error       text,
  PRIMARY KEY (event_id, destination)
);

-- §5.3e: journaled on an auxiliary, autocommitted connection before the effect.
CREATE TABLE IF NOT EXISTS ordertruth_guard.commit_intents (
  call_id           text PRIMARY KEY,
  merchant_id       text NOT NULL,
  boundary          text NOT NULL CHECK (boundary IN ('ISSUANCE','OPERATION','REJECTION_AUDIT')),
  identity          jsonb NOT NULL,
  backend_pid       integer NOT NULL,
  backend_start     timestamptz NOT NULL,
  postmaster_start  timestamptz NOT NULL,
  resolved_state    text CHECK (resolved_state IN ('COMMITTED','NOT_COMMITTED_ESTABLISHED','STILL_UNKNOWN')),
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- §5.3e: written last inside the transaction; commits if and only if the transaction commits.
CREATE TABLE IF NOT EXISTS ordertruth_guard.commit_markers (
  call_id         text PRIMARY KEY,
  merchant_id     text NOT NULL,
  boundary        text NOT NULL CHECK (boundary IN ('ISSUANCE','OPERATION','REJECTION_AUDIT')),
  outcome_record  jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
