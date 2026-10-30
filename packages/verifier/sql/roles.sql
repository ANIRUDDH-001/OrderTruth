-- OrderTruth v3 Gate A verifier roles (plan Task 9). Trusted and manifest-pinned.
-- Variables use psql syntax (:'name' literal, :"name" identifier); the controller substitutes them itself so passwords
-- never appear on a command line. Run as a superuser. Four sections: `cluster` once; `database` in each template database
-- after its schemas exist (owned by ot_setup); `template` on each finished template, which then refuses all connections, so a
-- candidate can never write state that every later clone would inherit (review CP3 B1); `connect` on every clone, because
-- database-level privileges belong to the database itself and aren't copied from a template.
--
-- ot_candidate: the untrusted merchant code. USAGE and SELECT/INSERT/UPDATE on shop and ordertruth_guard only. No DELETE,
--   TRUNCATE, TRIGGER or CREATE, and no pg_read_all_stats. The guard's resolver runs as this same role (the spec's allowed case).
-- ot_observer: the verifier. Read-only on shop and ordertruth_guard; owns verifier_oracle; may read pg_stat_activity in full.

-- @section cluster
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ot_setup') THEN CREATE ROLE ot_setup LOGIN CREATEDB; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ot_candidate') THEN CREATE ROLE ot_candidate LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ot_observer') THEN CREATE ROLE ot_observer LOGIN; END IF;
END $$;
ALTER ROLE ot_candidate NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'candidate_password';
ALTER ROLE ot_observer NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'observer_password';
REVOKE pg_read_all_stats FROM ot_candidate;
GRANT pg_read_all_stats TO ot_observer;
-- No foothold outside the merchant clones: PUBLIC's default CONNECT and TEMPORARY on the maintenance databases go.
REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;

-- @section database
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA shop, ordertruth_guard TO ot_candidate, ot_observer;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA shop, ordertruth_guard TO ot_candidate;
GRANT SELECT ON ALL TABLES IN SCHEMA shop, ordertruth_guard TO ot_observer;
CREATE SCHEMA verifier_oracle AUTHORIZATION ot_observer;
REVOKE ALL ON SCHEMA verifier_oracle FROM PUBLIC;
CREATE TABLE verifier_oracle.expected (rung text NOT NULL, intent_id text NOT NULL, expected_orders integer NOT NULL);
ALTER TABLE verifier_oracle.expected OWNER TO ot_observer;
INSERT INTO verifier_oracle.expected VALUES ('L1', 'SYN-INT-1', 1), ('L3', 'SYN-INT-1', 1), ('L4', 'SYN-INT-1', 1), ('L7', 'SYN-INT-2', 1);

-- @section template
REVOKE ALL ON DATABASE :"database" FROM PUBLIC, ot_candidate, ot_observer;
ALTER DATABASE :"database" WITH ALLOW_CONNECTIONS false;

-- @section connect
REVOKE ALL ON DATABASE :"database" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database" TO ot_candidate, ot_observer;
