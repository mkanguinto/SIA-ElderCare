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
