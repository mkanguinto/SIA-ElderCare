-- Batch 1 (account verification / handover / monitoring status): check-in review status, the nurse who
-- reviewed it, the action taken, the devices used to measure, and a timestamped log of every status change.

DO $$ BEGIN
  CREATE TYPE checkin_status AS ENUM ('received', 'awaiting_review', 'reviewed', 'action_recorded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE checkins ADD COLUMN IF NOT EXISTS status             checkin_status NOT NULL DEFAULT 'received';
ALTER TABLE checkins ADD COLUMN IF NOT EXISTS reviewed_by_nurse  TEXT;          -- user id of the nurse
ALTER TABLE checkins ADD COLUMN IF NOT EXISTS reviewed_by_name   TEXT;
ALTER TABLE checkins ADD COLUMN IF NOT EXISTS reviewed_at        TIMESTAMPTZ;
ALTER TABLE checkins ADD COLUMN IF NOT EXISTS review_note        TEXT;
ALTER TABLE checkins ADD COLUMN IF NOT EXISTS action_taken       TEXT;
ALTER TABLE checkins ADD COLUMN IF NOT EXISTS action_by          TEXT;
ALTER TABLE checkins ADD COLUMN IF NOT EXISTS action_by_name     TEXT;
ALTER TABLE checkins ADD COLUMN IF NOT EXISTS action_at          TIMESTAMPTZ;
-- {"bp": "upper_arm_digital", "thermometer": "digital_oral", "oximeter": "fingertip"}
ALTER TABLE checkins ADD COLUMN IF NOT EXISTS measurement_device JSONB;

CREATE TABLE IF NOT EXISTS checkin_status_log (
  id          BIGSERIAL PRIMARY KEY,
  checkin_id  UUID           NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
  status      checkin_status NOT NULL,
  changed_by  TEXT           NOT NULL,      -- user id, or 'system' for automatic steps
  changed_by_name TEXT,
  note        TEXT,
  changed_at  TIMESTAMPTZ    NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checkin_status_log ON checkin_status_log (checkin_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_checkins_review ON checkins (status, recorded_at DESC) WHERE status IN ('received', 'awaiting_review');

-- Existing check-ins were already delivered to the clinic queue: record them as received -> awaiting review.
INSERT INTO checkin_status_log (checkin_id, status, changed_by, note, changed_at)
  SELECT id, 'received', caregiver_id, 'backfilled by migration 0001', created_at FROM checkins;
INSERT INTO checkin_status_log (checkin_id, status, changed_by, note, changed_at)
  SELECT id, 'awaiting_review', 'system', 'backfilled by migration 0001', created_at FROM checkins;
UPDATE checkins SET status = 'awaiting_review';
