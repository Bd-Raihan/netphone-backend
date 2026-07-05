CREATE INDEX IF NOT EXISTS idx_call_sessions_status_started_at
ON call_sessions(status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_sessions_rate_id
ON call_sessions(rate_id);

CREATE INDEX IF NOT EXISTS idx_call_sessions_user_id
ON call_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_type_created_at
ON wallet_transactions(type, created_at DESC);