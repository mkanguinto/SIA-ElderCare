-- Batch 3a: accounts in PostgreSQL (auth_db), one-time account codes, and the account audit log.
-- data/users.json stays the bootstrap list: accounts in it that are not in the table yet are imported at start-up.

CREATE TABLE IF NOT EXISTS accounts (
  id                   TEXT PRIMARY KEY,                       -- U-CG-001, U-FM-001, U-CS-001, U-AD-001
  username             TEXT        NOT NULL,
  name                 TEXT        NOT NULL,
  role                 TEXT        NOT NULL CHECK (role IN ('caregiver', 'family_member', 'clinic_staff', 'system_admin')),
  phone                TEXT,                                   -- E.164, for activation codes and reset links
  patients             TEXT[]      NOT NULL DEFAULT '{}',
  scopes               TEXT[]      NOT NULL DEFAULT '{}',
  password_hash        TEXT,                                   -- NULL until the user activates the account
  status               TEXT        NOT NULL DEFAULT 'pending_activation'
                       CHECK (status IN ('pending_activation', 'active', 'disabled')),
  created_by           TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at         TIMESTAMPTZ,
  password_changed_at  TIMESTAMPTZ,
  last_login_at        TIMESTAMPTZ,
  disabled_at          TIMESTAMPTZ,
  disabled_by          TEXT,
  disabled_reason      TEXT,
  CHECK (status <> 'active' OR password_hash IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_username ON accounts (lower(username));

-- Activation codes and password-reset links. Only a keyed hash of the secret is stored; the secret itself goes
-- to the user's phone by SMS and is never shown to (or retrievable by) the admin who requested it.
CREATE TABLE IF NOT EXISTS account_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   TEXT        NOT NULL REFERENCES accounts(id),
  purpose      TEXT        NOT NULL CHECK (purpose IN ('activation', 'password_reset')),
  secret_hash  TEXT        NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     SMALLINT    NOT NULL DEFAULT 0,
  used_at      TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,                                     -- replaced by a newer code / link
  sent_to      TEXT,                                            -- masked number, e.g. +63 •••• ••• 0102
  delivery     TEXT,                                            -- sent | simulated | failed
  created_by   TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_tokens_open ON account_tokens (account_id, purpose) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_tokens_secret ON account_tokens (secret_hash);

-- Every account action with who did it and when (Section 12 audit trail). Append-only.
CREATE TABLE IF NOT EXISTS account_audit (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id    TEXT        NOT NULL,       -- user id, 'system', or 'anonymous' (failed sign-in, unknown user)
  actor_role  TEXT,
  action      TEXT        NOT NULL,
  target_id   TEXT,                       -- the account acted on
  ip          TEXT,
  details     JSONB       NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_account_audit_at ON account_audit (at DESC);
CREATE INDEX IF NOT EXISTS idx_account_audit_target ON account_audit (target_id, at DESC);

CREATE OR REPLACE FUNCTION account_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'account_audit is append-only' USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_account_audit_append_only ON account_audit;
CREATE TRIGGER trg_account_audit_append_only BEFORE UPDATE OR DELETE ON account_audit
  FOR EACH ROW EXECUTE FUNCTION account_audit_append_only();
