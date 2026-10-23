-- Batch 1 amendment: why a vital sign has no value, and immutable status history.

-- {"bp": "no_device", "spo2": "not_measured", "bloodGlucose": "unknown"} - a missing reading is recorded as a
-- reason, never as zero, so a nurse can tell "not taken" from "taken and normal".
ALTER TABLE checkins ADD COLUMN IF NOT EXISTS vitals_missing JSONB;

-- The status only moves forward (received -> awaiting_review -> reviewed -> action_recorded), and once a
-- nurse has reviewed a check-in, who reviewed it and when cannot be rewritten.
CREATE OR REPLACE FUNCTION checkins_status_forward_only() RETURNS trigger AS $$
BEGIN
  IF NEW.status < OLD.status THEN
    RAISE EXCEPTION 'check-in status cannot move back from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.reviewed_at IS NOT NULL AND (NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
      OR NEW.reviewed_by_nurse IS DISTINCT FROM OLD.reviewed_by_nurse) THEN
    RAISE EXCEPTION 'the review of a check-in cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_checkins_status_forward_only ON checkins;
CREATE TRIGGER trg_checkins_status_forward_only BEFORE UPDATE ON checkins
  FOR EACH ROW EXECUTE FUNCTION checkins_status_forward_only();

-- The status log is append-only (rows still go when their check-in is deleted, through ON DELETE CASCADE).
CREATE OR REPLACE FUNCTION checkin_status_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'checkin_status_log is append-only' USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_checkin_status_log_append_only ON checkin_status_log;
CREATE TRIGGER trg_checkin_status_log_append_only BEFORE UPDATE ON checkin_status_log
  FOR EACH ROW EXECUTE FUNCTION checkin_status_log_append_only();
