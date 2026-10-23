-- Family / caregiver contacts with the clinic: proof of who contacted the clinic, when, why, and what the clinic did.
-- channel: message (a written request, e.g. "please call me back") | call (a call started from the app: the
-- app cannot tell whether it connected, so it is recorded as "call started").
-- status: sent -> seen (a nurse opened it) -> answered (nurse replied) | closed (nurse closed it with a note).
CREATE TABLE IF NOT EXISTS contact_requests (
  id              TEXT PRIMARY KEY,                     -- CR-000123
  seq             BIGSERIAL UNIQUE,
  patient_id      TEXT        NOT NULL,
  patient_name    TEXT,
  from_user_id    TEXT        NOT NULL,
  from_name       TEXT        NOT NULL,
  from_role       TEXT        NOT NULL CHECK (from_role IN ('family_member', 'caregiver')),
  channel         TEXT        NOT NULL CHECK (channel IN ('message', 'call')),
  reason          TEXT        NOT NULL,
  message         TEXT,
  callback        BOOLEAN     NOT NULL DEFAULT false,   -- asks the clinic to call back
  status          TEXT        NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'seen', 'answered', 'closed')),
  clinic_sms      TEXT,                                 -- notice to the clinic hotline: simulated | queued | sent | delivered | failed | not_configured
  clinic_sms_note TEXT,
  clinic_sms_ref  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at         TIMESTAMPTZ,
  seen_by         TEXT,
  seen_by_name    TEXT,
  reply           TEXT,
  replied_at      TIMESTAMPTZ,
  replied_by      TEXT,
  replied_by_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_contact_patient ON contact_requests (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_open ON contact_requests (status, created_at) WHERE status IN ('sent', 'seen');

-- Every step, append-only: the evidence trail shown to the family and the nurse.
CREATE TABLE IF NOT EXISTS contact_request_events (
  id          BIGSERIAL PRIMARY KEY,
  request_id  TEXT        NOT NULL REFERENCES contact_requests(id),
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id    TEXT        NOT NULL,
  actor_name  TEXT,
  actor_role  TEXT,
  event       TEXT        NOT NULL,   -- requested | call_started | clinic_notified | seen | answered | closed
  details     JSONB       NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_contact_events ON contact_request_events (request_id, at);

CREATE OR REPLACE FUNCTION contact_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'contact_request_events is append-only' USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_contact_events_append_only ON contact_request_events;
CREATE TRIGGER trg_contact_events_append_only BEFORE UPDATE OR DELETE ON contact_request_events
  FOR EACH ROW EXECUTE FUNCTION contact_events_append_only();
