-- Batch 2: care teams, monitoring plans, case ownership and nurse handover.
--
-- An elder belongs to a care team (several nurses), not to one nurse. One nurse on the team holds the case
-- (case_nurse_id). The case moves to another nurse only when that nurse accepts a handover; until then the
-- handover is pending and the outgoing nurse still holds the case. Duty coverage (on/off duty) is recorded
-- separately and has nothing to do with login sessions: signing out never hands over or drops a case.

CREATE TABLE IF NOT EXISTS care_teams (
  id          TEXT PRIMARY KEY,                    -- e.g. CT-MNL-A
  name        TEXT        NOT NULL,
  clinic_id   TEXT,                                -- e.g. RHU-MNL-01
  created_by  TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS care_team_members (
  id          BIGSERIAL PRIMARY KEY,
  team_id     TEXT        NOT NULL REFERENCES care_teams(id),
  nurse_id    TEXT        NOT NULL,                -- gateway user id (clinic_staff)
  nurse_name  TEXT        NOT NULL,
  team_role   TEXT        NOT NULL DEFAULT 'nurse' CHECK (team_role IN ('nurse', 'lead')),
  added_by    TEXT        NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_by  TEXT,
  removed_at  TIMESTAMPTZ                          -- membership history is kept, never deleted
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_team_member_active ON care_team_members (team_id, nurse_id) WHERE removed_at IS NULL;

-- How closely an elder is monitored: expected check-ins per day and how soon a nurse must review them.
CREATE TABLE IF NOT EXISTS monitoring_plans (
  id                   TEXT PRIMARY KEY,           -- e.g. MP-DAILY
  name                 TEXT     NOT NULL,
  checkins_per_day     SMALLINT NOT NULL CHECK (checkins_per_day BETWEEN 1 AND 6),
  review_within_hours  SMALLINT NOT NULL CHECK (review_within_hours BETWEEN 1 AND 72),
  description          TEXT
);

-- Clinic-side record of each elder (the patient master stays in the check-in service; database per service).
CREATE TABLE IF NOT EXISTS patient_care (
  patient_id          TEXT PRIMARY KEY,
  patient_name        TEXT        NOT NULL,
  care_team_id        TEXT        REFERENCES care_teams(id),
  monitoring_plan_id  TEXT        REFERENCES monitoring_plans(id),
  case_nurse_id       TEXT,                        -- the nurse holding the case now
  case_nurse_name     TEXT,
  case_since          TIMESTAMPTZ,
  updated_by          TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS handover_record (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id       TEXT        NOT NULL REFERENCES patient_care(patient_id),
  queue_item_id    UUID        REFERENCES risk_queue(id),   -- the open case at the time, if any
  from_nurse       TEXT        NOT NULL,
  from_nurse_name  TEXT,
  to_nurse         TEXT        NOT NULL,
  to_nurse_name    TEXT,
  concern          TEXT        NOT NULL,
  action_taken     TEXT        NOT NULL,
  pending_action   TEXT        NOT NULL,
  due_time         TIMESTAMPTZ NOT NULL,                     -- when the pending action is due
  status           TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at     TIMESTAMPTZ,                              -- accepted / declined / cancelled at
  responded_by     TEXT,
  response_note    TEXT,
  CHECK (from_nurse <> to_nurse)
);
-- One pending handover per elder at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_handover_pending ON handover_record (patient_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_handover_to ON handover_record (to_nurse, status);
CREATE INDEX IF NOT EXISTS idx_handover_chain ON handover_record (patient_id, created_at);

-- The handover chain is a record: a handover is answered once and its content never changes.
CREATE OR REPLACE FUNCTION handover_record_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'handover records cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'handover % is already %', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.patient_id, NEW.from_nurse, NEW.to_nurse, NEW.concern, NEW.action_taken, NEW.pending_action, NEW.due_time, NEW.created_at)
     IS DISTINCT FROM (OLD.patient_id, OLD.from_nurse, OLD.to_nurse, OLD.concern, OLD.action_taken, OLD.pending_action, OLD.due_time, OLD.created_at) THEN
    RAISE EXCEPTION 'handover content cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_handover_record_guard ON handover_record;
CREATE TRIGGER trg_handover_record_guard BEFORE UPDATE OR DELETE ON handover_record
  FOR EACH ROW EXECUTE FUNCTION handover_record_guard();

-- Clinic risk queue: whether the case behind this item is being handed over.
ALTER TABLE risk_queue ADD COLUMN IF NOT EXISTS handover_status TEXT NOT NULL DEFAULT 'none';
DO $$ BEGIN
  ALTER TABLE risk_queue ADD CONSTRAINT risk_queue_handover_status_check CHECK (handover_status IN ('none', 'pending', 'accepted'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Duty coverage, set by the nurse (or a team lead / admin), independent of login sessions.
CREATE TABLE IF NOT EXISTS nurse_duty (
  nurse_id    TEXT PRIMARY KEY,
  nurse_name  TEXT        NOT NULL,
  on_duty     BOOLEAN     NOT NULL DEFAULT FALSE,
  changed_by  TEXT        NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who changed care teams, monitoring plans, case assignments and duty, and when.
CREATE TABLE IF NOT EXISTS care_assignment_log (
  id          BIGSERIAL PRIMARY KEY,
  action      TEXT        NOT NULL,   -- team_created | member_added | member_removed | patient_assigned | case_assigned | duty_changed | handover_*
  actor_id    TEXT        NOT NULL,
  actor_role  TEXT        NOT NULL,
  patient_id  TEXT,
  team_id     TEXT,
  details     JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_care_log_time ON care_assignment_log (created_at DESC);

-- Standard monitoring plans (reference data, needed in every deployment).
INSERT INTO monitoring_plans (id, name, checkins_per_day, review_within_hours, description) VALUES
  ('MP-DAILY',    'Daily check-in',                 1, 24, 'One check-in a day, reviewed within 24 hours'),
  ('MP-BP-TWICE', 'Blood pressure twice a day',     2, 12, 'Morning and evening BP for uncontrolled hypertension, reviewed within 12 hours'),
  ('MP-HIGH',     'High-risk close monitoring',     3,  4, 'Three check-ins a day after a hospital stay or a critical reading, reviewed within 4 hours')
ON CONFLICT (id) DO NOTHING;
