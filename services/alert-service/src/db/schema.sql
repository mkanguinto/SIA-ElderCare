-- Family Alert & Notification Service - owns: alert rules, notification logs, family subscriber contacts.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS subscribers (
  id            SERIAL PRIMARY KEY,
  patient_id    TEXT        NOT NULL,              -- reference to checkin-service patient (no cross-DB FK)
  user_id       TEXT,                              -- platform user, if the subscriber has an account
  name          TEXT        NOT NULL,
  relation      TEXT        NOT NULL CHECK (relation IN ('caregiver','family','sponsor')),
  phone_e164    TEXT        NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  sms_enabled   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (patient_id, phone_e164)
);
CREATE INDEX IF NOT EXISTS idx_subscribers_patient ON subscribers (patient_id);

CREATE TABLE IF NOT EXISTS alert_rules (
  code          TEXT PRIMARY KEY,
  description   TEXT        NOT NULL,
  min_severity  TEXT        NOT NULL DEFAULT 'moderate',   -- low | moderate | high | critical
  channels      TEXT[]      NOT NULL DEFAULT '{sms,in_app}',
  enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
  config        JSONB       NOT NULL DEFAULT '{}'
);

-- Every alert raised (also the in-app notification feed for the Family Dashboard).
CREATE TABLE IF NOT EXISTS alerts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id    TEXT        NOT NULL,
  source        TEXT        NOT NULL,     -- anomaly | weather | manual | missed_checkin
  rule_code     TEXT,
  severity      TEXT        NOT NULL,
  title         TEXT        NOT NULL,
  message       TEXT        NOT NULL,
  metadata      JSONB       NOT NULL DEFAULT '{}',
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alerts_patient_time ON alerts (patient_id, created_at DESC);

-- Per-recipient delivery log (SMS via Twilio).
CREATE TABLE IF NOT EXISTS notification_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id      UUID        NOT NULL REFERENCES alerts(id),
  subscriber_id INT         REFERENCES subscribers(id),
  channel       TEXT        NOT NULL,     -- sms | in_app
  status        TEXT        NOT NULL,     -- queued | sent | delivered | failed | simulated | undelivered
  provider_sid  TEXT,
  attempts      INT         NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_alert ON notification_log (alert_id);
CREATE INDEX IF NOT EXISTS idx_notification_sid ON notification_log (provider_sid);

-- Idempotent event consumption (outbox delivers at-least-once).
CREATE TABLE IF NOT EXISTS processed_events (
  event_id      UUID PRIMARY KEY,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prevent re-alerting the same patient for the same weather hazard every poll.
CREATE TABLE IF NOT EXISTS alert_dedupe (
  dedupe_key    TEXT PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cached OpenWeatherMap responses per zip (Risk 1 & Risk 5 mitigation).
CREATE TABLE IF NOT EXISTS weather_cache (
  zip_code      TEXT        NOT NULL,
  country_code  CHAR(2)     NOT NULL,
  payload       JSONB       NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (zip_code, country_code)
);

INSERT INTO alert_rules (code, description, min_severity, channels, config) VALUES
  ('HEALTH_ANOMALY',  'Abnormal vitals / fall / confusion from a caregiver check-in', 'moderate', '{sms,in_app}', '{}'),
  ('MISSED_CHECKIN',  'No caregiver check-in within the expected window',            'moderate', '{sms,in_app}', '{}'),
  ('WEATHER_HEAT',    'Heat index above threshold for at-risk patients',             'moderate', '{sms,in_app}', '{"heatIndexThresholdC":40}'),
  ('WEATHER_STORM',   'Severe storm / typhoon advisory for mobility-restricted patients', 'high', '{sms,in_app}', '{}'),
  ('MANUAL',          'Alert dispatched manually by clinic staff / admin',          'low',      '{sms,in_app}', '{}')
ON CONFLICT (code) DO NOTHING;

-- v1.1: SMS provider tracking (TextBee / Twilio) and safety notes (allow-list, daily limit)
ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS note     TEXT;
ALTER TABLE subscribers      ADD COLUMN IF NOT EXISTS created_by TEXT;

-- ------------------------------------------------------------------------------------------
-- v2 (RabbitMQ + TextBee): transactional outbox for weather.risk_detected and
-- notification.sms.requested events (relay publishes to the eldercare.events exchange).
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

-- SMS worker idempotency: a notification moves queued -> sending -> sent|simulated|failed|unconfirmed
-- exactly once. sending_started_at lets a redelivery tell "in flight" from "crashed mid-send".
ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS sending_started_at TIMESTAMPTZ;
ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS alert_type TEXT;
