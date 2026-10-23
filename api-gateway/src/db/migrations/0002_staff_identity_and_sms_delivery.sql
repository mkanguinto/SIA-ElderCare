-- Batch 3a review: one staff identity behind separate admin and nurse accounts, and honest SMS delivery status.

-- A person who is both admin and nurse has two accounts (each with its own password, session and role), linked
-- by one staff ID so the audit trail shows it is the same person. Only staff accounts carry one, and a person
-- has at most one account per role.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS staff_id TEXT;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS ck_accounts_staff_id;
ALTER TABLE accounts ADD CONSTRAINT ck_accounts_staff_id
  CHECK (staff_id IS NULL OR (role IN ('clinic_staff', 'system_admin') AND staff_id ~ '^ST-[0-9]{3,6}$'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_staff_role ON accounts (staff_id, role) WHERE staff_id IS NOT NULL;

ALTER TABLE account_audit ADD COLUMN IF NOT EXISTS actor_staff_id TEXT;
ALTER TABLE account_audit ADD COLUMN IF NOT EXISTS target_staff_id TEXT;
CREATE INDEX IF NOT EXISTS idx_account_audit_actor_staff ON account_audit (actor_staff_id, at DESC) WHERE actor_staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_account_audit_target_staff ON account_audit (target_staff_id, at DESC) WHERE target_staff_id IS NOT NULL;

-- delivery: simulated (NOT sent) | queued | sent (left the SMS phone) | delivered | failed | unknown.
-- Only 'delivered' means the person's phone received it.
ALTER TABLE account_tokens ADD COLUMN IF NOT EXISTS delivery_note TEXT;
ALTER TABLE account_tokens ADD COLUMN IF NOT EXISTS provider_ref TEXT;
ALTER TABLE account_tokens ADD COLUMN IF NOT EXISTS delivery_updated_at TIMESTAMPTZ;
