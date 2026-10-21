/** Additive upgrade: old inference rows without saved input remain historical
 * records, but cannot be presented as a reproducible investigation. */
export const POSTGRES_INVESTIGATION_HISTORY_V7 = String.raw`
ALTER TABLE ai_investigations ADD COLUMN evidence_json TEXT CHECK(evidence_json IS NULL OR ot_json_valid(evidence_json));
CREATE OR REPLACE FUNCTION ot_ai_result_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.status<>'RESERVED' OR NEW.evidence_json IS NULL
   OR NOT EXISTS(SELECT 1 FROM scenario_runs r WHERE r.id=NEW.run_id AND r.user_id=NEW.user_id)
   THEN RAISE EXCEPTION 'AI reservation requires its owned scenario and evidence'; END IF;
 ELSE
   IF TG_OP='DELETE' OR OLD.status<>'RESERVED' OR NEW.status NOT IN('FRESH','UNAVAILABLE')
   OR (NEW.id,NEW.run_id,NEW.user_id,NEW.snapshot_sha256,NEW.model,NEW.requested_at,NEW.evidence_json)
   IS DISTINCT FROM (OLD.id,OLD.run_id,OLD.user_id,OLD.snapshot_sha256,OLD.model,OLD.requested_at,OLD.evidence_json)
   OR (NEW.status='FRESH' AND (NEW.result_json IS NULL OR NEW.usage_json IS NULL))
   THEN RAISE EXCEPTION 'AI terminal result and original evidence are immutable'; END IF;
 END IF;
 RETURN NEW;
END $ot$;
`;
