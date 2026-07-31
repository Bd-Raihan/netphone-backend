BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_created_at
  ON users (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_users_status_last_login
  ON users (status, last_login_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_sessions_profit_report
  ON call_sessions (status, started_at DESC)
  WHERE status = 'charged';

CREATE INDEX IF NOT EXISTS idx_call_sessions_profit_country
  ON call_sessions (provider_rate_id, rate_id)
  WHERE status = 'charged';

COMMIT;
