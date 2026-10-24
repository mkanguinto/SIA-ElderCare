-- Batch 1 follow-up: real check-ins are never marked reviewed because of their age. Pending real records stay in
-- the nurse's review lists (older ones in a "historical" list); only records clearly identified as demo or test
-- data are archived, separately, without changing their review status.

ALTER TABLE checkins ADD COLUMN IF NOT EXISTS data_origin    TEXT NOT NULL DEFAULT 'live';
ALTER TABLE checkins ADD COLUMN IF NOT EXISTS archived_at    TIMESTAMPTZ;
ALTER TABLE checkins ADD COLUMN IF NOT EXISTS archived_by    TEXT;          -- user id, or 'system' for this migration
ALTER TABLE checkins ADD COLUMN IF NOT EXISTS archive_reason TEXT;
DO $$ BEGIN
  ALTER TABLE checkins ADD CONSTRAINT checkins_data_origin_check CHECK (data_origin IN ('live', 'demo'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Only demo records can be archived; a real check-in leaves the lists only by being reviewed by a nurse.
  ALTER TABLE checkins ADD CONSTRAINT checkins_archive_demo_only CHECK (archived_at IS NULL OR data_origin = 'demo');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_checkins_pending ON checkins (recorded_at) WHERE archived_at IS NULL AND status IN ('received', 'awaiting_review');

-- Clearly identified test data: check-ins created by the automated suites, which use their own idempotency keys
-- (Postman "pm-...", smoke test "offline-...", SMS tests "sms-smoke..." / "sms-pm...", "env-test-..."; same rule as
-- isTestRecordKey in validation.js). Check-ins without such a marker are treated as real records.
UPDATE checkins SET data_origin = 'demo'
 WHERE data_origin = 'live' AND idempotency_key ~ '^(pm-|offline-|sms-smoke|sms-pm|env-test-)';

UPDATE checkins SET archived_at = now(), archived_by = 'system',
       archive_reason = 'Automated test record (identified by its test idempotency key), archived by migration 0003'
 WHERE data_origin = 'demo' AND archived_at IS NULL AND status IN ('received', 'awaiting_review');
