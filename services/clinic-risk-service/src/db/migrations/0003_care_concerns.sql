-- Concerns a caregiver (or a nurse) raises about an elder, and how a nurse deals with them.
--
-- A concern is separate from finishing a care task and from reviewing a check-in: it stays open until a nurse
-- resolves it with an assessment and the action taken. A completed checklist, a normal reading or a reviewed
-- check-in never closes it. Every step is kept (concern_events, append-only). Open concerns travel with a nurse
-- handover, and the incoming nurse acknowledges them when accepting.

CREATE SEQUENCE IF NOT EXISTS care_concern_seq START 1;

CREATE TABLE IF NOT EXISTS care_concerns (
  id                TEXT PRIMARY KEY,                          -- CC-000001
  patient_id        TEXT        NOT NULL,
  patient_name      TEXT,
  category          TEXT        NOT NULL,
  description       TEXT        NOT NULL,
  related           JSONB       NOT NULL DEFAULT '{}',         -- {taskReportId, medicationReportId, checkinId}
  reported_by       TEXT        NOT NULL,
  reporter_name     TEXT,
  reporter_role     TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_by   TEXT,
  acknowledged_at   TIMESTAMPTZ,
  resolved_by       TEXT,
  resolved_by_name  TEXT,
  resolved_at       TIMESTAMPTZ,
  assessment        TEXT,
  action_taken      TEXT,
  CHECK (status <> 'resolved' OR (assessment IS NOT NULL AND action_taken IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_care_concerns_patient ON care_concerns (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_care_concerns_open ON care_concerns (status) WHERE status <> 'resolved';

-- What was reported never changes; a resolved concern stays resolved (a new concern is raised instead).
CREATE OR REPLACE FUNCTION care_concern_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'concerns cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION 'concern % is resolved and cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.patient_id, NEW.category, NEW.description, NEW.related, NEW.reported_by, NEW.reporter_role, NEW.created_at)
     IS DISTINCT FROM (OLD.patient_id, OLD.category, OLD.description, OLD.related, OLD.reported_by, OLD.reporter_role, OLD.created_at) THEN
    RAISE EXCEPTION 'what was reported cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_care_concern_guard ON care_concerns;
CREATE TRIGGER trg_care_concern_guard BEFORE UPDATE OR DELETE ON care_concerns FOR EACH ROW EXECUTE FUNCTION care_concern_guard();

CREATE TABLE IF NOT EXISTS concern_events (
  id          BIGSERIAL PRIMARY KEY,
  concern_id  TEXT        NOT NULL REFERENCES care_concerns(id),
  event       TEXT        NOT NULL,      -- reported | acknowledged | note | resolved | handed_over
  actor_id    TEXT        NOT NULL,
  actor_name  TEXT,
  actor_role  TEXT,
  details     JSONB       NOT NULL DEFAULT '{}',
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_concern_events ON concern_events (concern_id, at);
CREATE OR REPLACE FUNCTION concern_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'the concern history is append-only' USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_concern_events_append_only ON concern_events;
CREATE TRIGGER trg_concern_events_append_only BEFORE UPDATE OR DELETE ON concern_events FOR EACH ROW EXECUTE FUNCTION concern_events_append_only();

-- Handover: the open concerns at the time (kept with the handover), and the incoming nurse's acknowledgement.
ALTER TABLE handover_record ADD COLUMN IF NOT EXISTS open_items JSONB NOT NULL DEFAULT '[]';
ALTER TABLE handover_record ADD COLUMN IF NOT EXISTS open_items_acknowledged BOOLEAN;
