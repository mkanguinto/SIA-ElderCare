-- Care Plan Service - owns: care plans, caregiver duty tasks, task completions (v2 Batch 4).
-- patient_id references the check-in service's patients by value only (no cross-database FK).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- One living care plan per patient (goals + notes); its tasks hang off the patient id.
CREATE TABLE IF NOT EXISTS care_plans (
  patient_id   TEXT        PRIMARY KEY,
  goals        TEXT,
  notes        TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS care_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id    TEXT        NOT NULL REFERENCES care_plans(patient_id),
  category      TEXT        NOT NULL CHECK (category IN ('personal_care','physical_medical','meals_household','transportation',
                                                         'emotional_social','home_safety','communication','records')),
  title         TEXT        NOT NULL,
  instructions  TEXT,
  frequency     TEXT        NOT NULL CHECK (frequency IN ('daily','weekly','once','as_needed')),
  times         TEXT[]      NOT NULL DEFAULT '{}',     -- HH:MM local time
  days_of_week  SMALLINT[]  NOT NULL DEFAULT '{}',     -- 0 = Sunday (weekly tasks)
  due_date      DATE,                                  -- one-time tasks
  start_date    DATE,
  end_date      DATE,
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_care_tasks_patient ON care_tasks (patient_id) WHERE active;

-- A caregiver ticking off (or skipping) one occurrence. slot = 'HH:MM', 'any', or 'log' for as-needed
-- tasks (which can be logged many times a day). Scheduled slots are unique, so ticking twice updates.
CREATE TABLE IF NOT EXISTS task_completions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        UUID        NOT NULL REFERENCES care_tasks(id),
  patient_id     TEXT        NOT NULL,
  scheduled_for  DATE        NOT NULL,
  slot           TEXT        NOT NULL,
  status         TEXT        NOT NULL CHECK (status IN ('done','skipped')),
  note           TEXT,
  completed_by   TEXT        NOT NULL,
  completed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_completion_slot ON task_completions (task_id, scheduled_for, slot) WHERE slot <> 'log';
CREATE INDEX IF NOT EXISTS idx_completions_patient_date ON task_completions (patient_id, scheduled_for DESC);

-- ------------------------------------------------------------------------------------------------------------
-- v3: nurse-led care plan versions, caregiver reports and nurse review (all statements idempotent).
--
-- A plan is a chain of versions per elder: draft -> active -> superseded (or a draft is discarded). Only one
-- active and one draft at a time. An active or superseded version's content never changes; a change is a new
-- draft that, once activated, supersedes the old one. Tasks belong to a version, so the checklist of a past day
-- still shows the instructions that applied that day. Every step is written to care_plan_events.
-- ------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS care_plan_versions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id            TEXT        NOT NULL,
  version               INT         NOT NULL,
  status                TEXT        NOT NULL CHECK (status IN ('draft', 'active', 'superseded', 'discarded')),
  content               JSONB       NOT NULL DEFAULT '{}',   -- preferences, goals, needs, allergies, instructions, contact
  care_team_id          TEXT,
  responsible_nurse_id  TEXT,
  responsible_nurse_name TEXT,
  elder_involved        BOOLEAN,                             -- planned with the elder
  caregiver_involved    BOOLEAN,                             -- planned with the caregiver
  involvement_note      TEXT,
  effective_date        DATE,
  review_date           DATE,
  verification          JSONB,                               -- clinician who verified clinical instructions
  legacy                BOOLEAN     NOT NULL DEFAULT FALSE,  -- carried over from the plan before versions
  change_summary        TEXT,
  created_by            TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_by          TEXT,
  activated_at          TIMESTAMPTZ,
  superseded_at         TIMESTAMPTZ,
  superseded_by         UUID,
  UNIQUE (patient_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_active ON care_plan_versions (patient_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_draft ON care_plan_versions (patient_id) WHERE status = 'draft';

-- An active or superseded version is a record: its content stays as it was. Allowed afterwards: active ->
-- superseded (with superseded_at / superseded_by). Versions are never deleted.
CREATE OR REPLACE FUNCTION care_plan_version_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'care plan versions cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('superseded', 'discarded') THEN
    RAISE EXCEPTION 'a % care plan version cannot change', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'active' AND (NEW.status <> 'superseded' OR NEW.content IS DISTINCT FROM OLD.content
      OR NEW.verification IS DISTINCT FROM OLD.verification OR NEW.effective_date IS DISTINCT FROM OLD.effective_date
      OR NEW.review_date IS DISTINCT FROM OLD.review_date OR NEW.responsible_nurse_id IS DISTINCT FROM OLD.responsible_nurse_id) THEN
    RAISE EXCEPTION 'an active care plan version can only be superseded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_care_plan_version_guard ON care_plan_versions;
CREATE TRIGGER trg_care_plan_version_guard BEFORE UPDATE OR DELETE ON care_plan_versions
  FOR EACH ROW EXECUTE FUNCTION care_plan_version_guard();

-- Change history (append-only): who did what to which version, and when.
CREATE TABLE IF NOT EXISTS care_plan_events (
  id          BIGSERIAL PRIMARY KEY,
  patient_id  TEXT        NOT NULL,
  version_id  UUID        REFERENCES care_plan_versions(id),
  action      TEXT        NOT NULL,
  actor_id    TEXT        NOT NULL,
  actor_role  TEXT,
  details     JSONB       NOT NULL DEFAULT '{}',
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_care_plan_events_patient ON care_plan_events (patient_id, at DESC);
CREATE OR REPLACE FUNCTION care_plan_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'the care plan history is append-only' USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_care_plan_events_append_only ON care_plan_events;
CREATE TRIGGER trg_care_plan_events_append_only BEFORE UPDATE OR DELETE ON care_plan_events
  FOR EACH ROW EXECUTE FUNCTION care_plan_events_append_only();

-- Tasks: which version they belong to, measurement tasks, and the clinical source of specialised instructions.
ALTER TABLE care_tasks ADD COLUMN IF NOT EXISTS plan_version_id UUID REFERENCES care_plan_versions(id);
ALTER TABLE care_tasks ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'task';
ALTER TABLE care_tasks ADD COLUMN IF NOT EXISTS measurement TEXT;
ALTER TABLE care_tasks ADD COLUMN IF NOT EXISTS specialised BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE care_tasks ADD COLUMN IF NOT EXISTS source JSONB;
ALTER TABLE care_tasks ADD COLUMN IF NOT EXISTS copied_from UUID;
DO $$ BEGIN
  ALTER TABLE care_tasks ADD CONSTRAINT care_tasks_kind_check CHECK (kind IN ('task', 'measurement'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_care_tasks_version ON care_tasks (plan_version_id);

-- Caregiver reports: the plan version the caregiver was looking at, readings, and nurse review.
ALTER TABLE task_completions DROP CONSTRAINT IF EXISTS task_completions_status_check;
DO $$ BEGIN
  ALTER TABLE task_completions ADD CONSTRAINT task_completions_status_check2 CHECK (status IN ('done', 'skipped', 'not_done', 'not_applicable'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS reading JSONB;
ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS measurement_status TEXT;
ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS checkin_id UUID;
ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS plan_version_id UUID;
ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS seen_plan_version INT;
ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS version_mismatch BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS client_recorded_at TIMESTAMPTZ;
ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS reviewed_by_name TEXT;
ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS review_note TEXT;

-- A corrected report keeps what was first said: the earlier values are copied here before the change.
CREATE TABLE IF NOT EXISTS report_revisions (
  id           BIGSERIAL PRIMARY KEY,
  report_type  TEXT        NOT NULL CHECK (report_type IN ('task', 'medication')),
  report_id    UUID        NOT NULL,
  previous     JSONB       NOT NULL,
  changed_by   TEXT        NOT NULL,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_report_revisions ON report_revisions (report_type, report_id);

-- Caregiver-reported medicine doses (Taken / Not taken / Unknown). This is what the caregiver said, not proof
-- that the dose was given. The medicine itself is the check-in service's prescription record (by value).
CREATE TABLE IF NOT EXISTS medication_reports (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          TEXT        NOT NULL,
  medication_id       INT         NOT NULL,
  medication          JSONB       NOT NULL,              -- the record as shown: name, strength, dose, route, food
  scheduled_for       DATE        NOT NULL,
  slot                TEXT        NOT NULL,              -- 'HH:MM' from the prescription, or 'prn' (as needed)
  status              TEXT        NOT NULL CHECK (status IN ('taken', 'not_taken', 'unknown')),
  actual_time         TIMESTAMPTZ,
  reason              TEXT,
  reported_by         TEXT        NOT NULL,
  reported_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_recorded_at  TIMESTAMPTZ,
  plan_version_id     UUID,
  seen_plan_version   INT,
  version_mismatch    BOOLEAN     NOT NULL DEFAULT FALSE,
  record_mismatch     BOOLEAN     NOT NULL DEFAULT FALSE, -- the prescription changed or ended after it was shown
  reviewed_by         TEXT,
  reviewed_by_name    TEXT,
  reviewed_at         TIMESTAMPTZ,
  review_note         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_medication_report_slot ON medication_reports (medication_id, scheduled_for, slot) WHERE slot <> 'prn';
CREATE INDEX IF NOT EXISTS idx_medication_reports_patient ON medication_reports (patient_id, scheduled_for DESC);
-- The carry-over of plans that existed before versions is in carryover.sql (run after the demo seed).
