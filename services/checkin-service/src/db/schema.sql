-- Daily Check-In Logger Service - owns: patients, check-in history, vital trends, baselines.
-- Runs automatically at service start-up (idempotent).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS patients (
  id                   TEXT PRIMARY KEY,
  full_name            TEXT        NOT NULL,
  birth_date           DATE,
  address_line         TEXT,
  zip_code             TEXT        NOT NULL,
  country_code         CHAR(2)     NOT NULL DEFAULT 'PH',
  latitude             NUMERIC(9,6),
  longitude            NUMERIC(9,6),
  conditions           TEXT[]      NOT NULL DEFAULT '{}',   -- e.g. {hypertension,cardiovascular,diabetes}
  mobility_restricted  BOOLEAN     NOT NULL DEFAULT FALSE,
  baseline             JSONB       NOT NULL DEFAULT '{}',   -- {systolic, diastolic, heartRate, temperatureC, spo2}
  assigned_clinic      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_patients_zip ON patients (zip_code);

CREATE TABLE IF NOT EXISTS checkins (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id           TEXT        NOT NULL REFERENCES patients(id),
  caregiver_id         TEXT        NOT NULL,
  idempotency_key      TEXT,                                -- offline-sync de-duplication (Risk 3)
  recorded_at          TIMESTAMPTZ NOT NULL,
  systolic             SMALLINT,
  diastolic            SMALLINT,
  heart_rate           SMALLINT,
  temperature_c        NUMERIC(4,1),
  spo2                 SMALLINT,
  blood_glucose        SMALLINT,
  medication_taken     BOOLEAN,
  missed_medications   TEXT[]      NOT NULL DEFAULT '{}',
  mobility_status      TEXT,
  mood                 TEXT,
  notes                TEXT,
  anomalies            JSONB       NOT NULL DEFAULT '[]',
  severity             TEXT        NOT NULL DEFAULT 'none',
  severity_score       SMALLINT    NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Outdoor conditions where the caregiver was when the check-in was taken (OpenWeatherMap via the alert service)
ALTER TABLE checkins ADD COLUMN IF NOT EXISTS environment JSONB;

CREATE INDEX IF NOT EXISTS idx_checkins_patient_time ON checkins (patient_id, recorded_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_checkins_idempotency ON checkins (caregiver_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Transactional outbox: events are written in the same DB transaction as the check-in,
-- then delivered to the Family Alert and Clinic Risk Queue services with retry (Section 15 saga).
CREATE TABLE IF NOT EXISTS outbox_events (
  id               BIGSERIAL PRIMARY KEY,
  event_id         UUID        NOT NULL,
  event_type       TEXT        NOT NULL,
  target           TEXT        NOT NULL,     -- "alert" | "clinic"
  payload          JSONB       NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'pending',   -- pending | delivered | failed
  attempts         INT         NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events (next_attempt_at) WHERE status = 'pending';

-- One missed-check-in flag per patient per day.
CREATE TABLE IF NOT EXISTS missed_checkin_flags (
  patient_id   TEXT NOT NULL REFERENCES patients(id),
  flag_date    DATE NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_id, flag_date)
);

-- ------------------------------------------------------------------------------------------
-- v1.1: patient onboarding + prescribed medications (all statements idempotent for upgrades)
-- ------------------------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS patient_id_seq START 1004;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS sex               TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS emergency_contact JSONB NOT NULL DEFAULT '{}';
ALTER TABLE patients ADD COLUMN IF NOT EXISTS notes             TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS created_by        TEXT;

CREATE TABLE IF NOT EXISTS patient_medications (
  id             SERIAL PRIMARY KEY,
  patient_id     TEXT        NOT NULL REFERENCES patients(id),
  name           TEXT        NOT NULL,
  dosage         TEXT        NOT NULL,
  frequency      TEXT        NOT NULL,
  times          TEXT[]      NOT NULL DEFAULT '{}',   -- e.g. {08:00,20:00}
  instructions   TEXT,
  prescribed_by  TEXT,
  start_date     DATE        NOT NULL DEFAULT current_date,
  end_date       DATE,
  active         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_patient_medications_patient ON patient_medications (patient_id, active);

-- v2 (RabbitMQ): one outbox row per event; the broker fans it out by routing key.
ALTER TABLE outbox_events ALTER COLUMN target SET DEFAULT 'broker';
