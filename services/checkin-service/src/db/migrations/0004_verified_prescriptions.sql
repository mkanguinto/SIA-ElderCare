-- Prescription records with their source and verification, changed only by a new record (never in place).
--
-- A nurse records a prescription from its source (the prescriber's order, a partner clinic, a hospital
-- discharge). A change of dose, time or route is a new record that supersedes the old one; stopping records who
-- ordered it and why. The old record stays as it was, so what the caregiver was told on a day can be shown.
-- Existing records are kept; they have no recorded source yet (shown as "source not recorded" until a nurse
-- records one through a revision).

ALTER TABLE patient_medications ADD COLUMN IF NOT EXISTS strength TEXT;
ALTER TABLE patient_medications ADD COLUMN IF NOT EXISTS dose TEXT;
ALTER TABLE patient_medications ADD COLUMN IF NOT EXISTS route TEXT;
ALTER TABLE patient_medications ADD COLUMN IF NOT EXISTS food_instructions TEXT;
ALTER TABLE patient_medications ADD COLUMN IF NOT EXISTS missed_dose_instructions TEXT;
ALTER TABLE patient_medications ADD COLUMN IF NOT EXISTS missed_dose_source JSONB;
ALTER TABLE patient_medications ADD COLUMN IF NOT EXISTS source JSONB;
ALTER TABLE patient_medications ADD COLUMN IF NOT EXISTS verification JSONB;
ALTER TABLE patient_medications ADD COLUMN IF NOT EXISTS supersedes_id INT REFERENCES patient_medications(id);
ALTER TABLE patient_medications ADD COLUMN IF NOT EXISTS superseded_by_id INT REFERENCES patient_medications(id);
ALTER TABLE patient_medications ADD COLUMN IF NOT EXISTS change_reason TEXT;
ALTER TABLE patient_medications ADD COLUMN IF NOT EXISTS stopped_at TIMESTAMPTZ;
ALTER TABLE patient_medications ADD COLUMN IF NOT EXISTS stopped_by TEXT;
ALTER TABLE patient_medications ADD COLUMN IF NOT EXISTS stop_reason TEXT;
ALTER TABLE patient_medications ADD COLUMN IF NOT EXISTS stop_source JSONB;

-- What the prescription says never changes after it is recorded. Allowed afterwards: stopping it (once),
-- linking the record that supersedes it, ending it, recording a verification that was missing, and updated_at.
CREATE OR REPLACE FUNCTION patient_medication_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'prescription records cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.name IS DISTINCT FROM OLD.name OR NEW.dosage IS DISTINCT FROM OLD.dosage OR NEW.frequency IS DISTINCT FROM OLD.frequency
     OR NEW.times IS DISTINCT FROM OLD.times OR NEW.instructions IS DISTINCT FROM OLD.instructions OR NEW.prescribed_by IS DISTINCT FROM OLD.prescribed_by
     OR NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.strength IS DISTINCT FROM OLD.strength OR NEW.dose IS DISTINCT FROM OLD.dose
     OR NEW.route IS DISTINCT FROM OLD.route OR NEW.food_instructions IS DISTINCT FROM OLD.food_instructions
     OR NEW.missed_dose_instructions IS DISTINCT FROM OLD.missed_dose_instructions OR NEW.missed_dose_source IS DISTINCT FROM OLD.missed_dose_source
     OR NEW.source IS DISTINCT FROM OLD.source OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id THEN
    RAISE EXCEPTION 'a prescription record cannot be changed in place; record a revision instead' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.active = FALSE AND NEW.active = TRUE THEN
    RAISE EXCEPTION 'a stopped or superseded prescription cannot be restarted; record a new one' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.verification IS NOT NULL AND OLD.verification <> 'null'::jsonb AND NEW.verification IS DISTINCT FROM OLD.verification THEN
    RAISE EXCEPTION 'a recorded verification cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.superseded_by_id IS NOT NULL AND NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id THEN
    RAISE EXCEPTION 'this prescription was already superseded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_patient_medication_guard ON patient_medications;
CREATE TRIGGER trg_patient_medication_guard BEFORE UPDATE OR DELETE ON patient_medications
  FOR EACH ROW EXECUTE FUNCTION patient_medication_guard();
