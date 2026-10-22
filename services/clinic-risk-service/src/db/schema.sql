-- Clinic Risk Queue Service - owns: patient risk scores, clinic follow-up actions, triage status.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS risk_queue (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id         TEXT        NOT NULL,
  patient_name       TEXT        NOT NULL,
  zip_code           TEXT,
  assigned_clinic    TEXT,
  conditions         TEXT[]      NOT NULL DEFAULT '{}',
  mobility_restricted BOOLEAN    NOT NULL DEFAULT FALSE,
  health_score       SMALLINT    NOT NULL DEFAULT 0,   -- internal severity (vitals / missed check-in)
  environment_score  SMALLINT    NOT NULL DEFAULT 0,   -- external exposure (heat / storm)
  emr_score          SMALLINT    NOT NULL DEFAULT 0,   -- legacy EMR history enrichment
  total_score        SMALLINT    NOT NULL DEFAULT 0,
  priority           TEXT        NOT NULL DEFAULT 'P4', -- P1 critical .. P4 routine
  status             TEXT        NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','in_review','scheduled','resolved','dismissed')),
  reasons            JSONB       NOT NULL DEFAULT '[]',
  assigned_to        TEXT,
  last_event_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one active triage item per patient; new signals update it instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS uq_risk_queue_active_patient
  ON risk_queue (patient_id) WHERE status IN ('open','in_review','scheduled');
CREATE INDEX IF NOT EXISTS idx_risk_queue_rank ON risk_queue (status, total_score DESC, last_event_at DESC);

CREATE TABLE IF NOT EXISTS followup_actions (
  id             BIGSERIAL PRIMARY KEY,
  queue_item_id  UUID        NOT NULL REFERENCES risk_queue(id),
  action         TEXT        NOT NULL,
  from_status    TEXT,
  to_status      TEXT,
  notes          TEXT,
  performed_by   TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_followup_item ON followup_actions (queue_item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS processed_events (
  event_id     UUID PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------------------------------
-- v1.1: explicit triage category, weather-risk expiry, case resolution history, scheduled visits
-- (idempotent so existing databases upgrade in place on service start)
-- ------------------------------------------------------------------------------------------
ALTER TABLE risk_queue ADD COLUMN IF NOT EXISTS category         TEXT;          -- urgent | high | watch | routine
ALTER TABLE risk_queue ADD COLUMN IF NOT EXISTS priority_rule    TEXT;          -- human-readable rule that set the priority
ALTER TABLE risk_queue ADD COLUMN IF NOT EXISTS environment_at   TIMESTAMPTZ;   -- when the weather signal was last refreshed
ALTER TABLE risk_queue ADD COLUMN IF NOT EXISTS health_at        TIMESTAMPTZ;   -- recorded_at of the check-in behind health_score
ALTER TABLE risk_queue ADD COLUMN IF NOT EXISTS resolved_at      TIMESTAMPTZ;
ALTER TABLE risk_queue ADD COLUMN IF NOT EXISTS resolved_by      TEXT;
ALTER TABLE risk_queue ADD COLUMN IF NOT EXISTS resolution_notes TEXT;

UPDATE risk_queue SET category = CASE priority WHEN 'P1' THEN 'urgent' WHEN 'P2' THEN 'high' WHEN 'P3' THEN 'watch' ELSE 'routine' END
 WHERE category IS NULL;
UPDATE risk_queue SET resolved_at = updated_at WHERE status IN ('resolved','dismissed') AND resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_risk_queue_history ON risk_queue (resolved_at DESC) WHERE status IN ('resolved','dismissed');

CREATE TABLE IF NOT EXISTS scheduled_visits (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_item_id     UUID REFERENCES risk_queue(id),
  patient_id        TEXT        NOT NULL,
  patient_name      TEXT        NOT NULL,
  visit_type        TEXT        NOT NULL CHECK (visit_type IN ('home_visit','clinic_visit','teleconsult')),
  visit_date        DATE        NOT NULL,          -- local date (Asia/Manila)
  visit_time        TIME        NOT NULL,          -- local time
  scheduled_for     TIMESTAMPTZ NOT NULL,          -- date + time as an absolute instant
  destination       TEXT        NOT NULL,          -- where: "Patient's home", "RHU Tondo", "Video call"
  location          TEXT        NOT NULL,          -- address / landmark / phone or meeting link
  contact_phone     TEXT,
  notes             TEXT,
  assigned_to       TEXT,
  status            TEXT        NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','completed','cancelled','no_show')),
  outcome           TEXT,
  cancelled_reason  TEXT,
  created_by        TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_visits_patient   ON scheduled_visits (patient_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_visits_upcoming  ON scheduled_visits (scheduled_for) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_visits_completed ON scheduled_visits (completed_at DESC) WHERE status = 'completed';

-- v2 (RabbitMQ): transactional outbox for events this service publishes (relay -> eldercare.events).
CREATE TABLE IF NOT EXISTS outbox_events (
  id               BIGSERIAL PRIMARY KEY,
  event_id         UUID        NOT NULL,
  event_type       TEXT        NOT NULL,     -- RabbitMQ routing key
  target           TEXT        NOT NULL DEFAULT 'broker',
  payload          JSONB       NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'pending',   -- pending | delivered | failed
  attempts         INT         NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events (next_attempt_at) WHERE status = 'pending';
