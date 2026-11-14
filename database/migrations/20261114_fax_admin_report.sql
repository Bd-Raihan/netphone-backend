BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
-- Separate admin presentation state only. No changes to Fax, documents, rates or wallet tables.
CREATE TABLE IF NOT EXISTS netphone_fax_admin_visibility (
 fax_id BIGINT PRIMARY KEY,
 archived BOOLEAN NOT NULL DEFAULT FALSE,
 actor_user_id BIGINT NOT NULL,
 reason TEXT NOT NULL CHECK(char_length(reason) BETWEEN 3 AND 300),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS netphone_fax_admin_report_audit (
 id BIGSERIAL PRIMARY KEY,
 fax_id BIGINT NOT NULL,
 actor_user_id BIGINT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('archive','restore')),
 reason TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='netphone_user') THEN
  GRANT SELECT,INSERT,UPDATE ON netphone_fax_admin_visibility TO netphone_user;
  GRANT SELECT,INSERT ON netphone_fax_admin_report_audit TO netphone_user;
  GRANT USAGE,SELECT ON SEQUENCE netphone_fax_admin_report_audit_id_seq TO netphone_user;
 END IF;
END $$;
COMMIT;
