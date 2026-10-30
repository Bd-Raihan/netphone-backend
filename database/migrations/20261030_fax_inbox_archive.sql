BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- Active archive membership only. Permanent action history uses existing netphone_fax_audit.
CREATE TABLE IF NOT EXISTS netphone_fax_inbox_archives (
 fax_id BIGINT PRIMARY KEY REFERENCES netphone_faxes(id),
 archived_by BIGINT NOT NULL REFERENCES users(id),
 archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 300)
);
COMMIT;
