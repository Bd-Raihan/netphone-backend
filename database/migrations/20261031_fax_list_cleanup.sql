BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE IF NOT EXISTS netphone_fax_history_hides (
 user_id BIGINT NOT NULL REFERENCES users(id),
 fax_id BIGINT NOT NULL REFERENCES netphone_faxes(id),
 hidden_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(user_id,fax_id)
);
CREATE TABLE IF NOT EXISTS netphone_fax_notification_hides (
 user_id BIGINT NOT NULL REFERENCES users(id),
 notification_id BIGINT NOT NULL REFERENCES netphone_fax_notifications(id),
 hidden_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(user_id,notification_id)
);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='netphone_user') THEN
  GRANT SELECT,INSERT ON netphone_fax_history_hides,netphone_fax_notification_hides TO netphone_user;
 END IF;
END $$;
COMMIT;
