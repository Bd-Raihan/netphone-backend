-- Rate table (admin managed)
CREATE TABLE IF NOT EXISTS call_rates (
  id BIGSERIAL PRIMARY KEY,
  country_code VARCHAR(8) NOT NULL,       -- e.g. "KW"
  prefix VARCHAR(16) NOT NULL,            -- e.g. "+965"
  currency VARCHAR(8) NOT NULL DEFAULT 'KWD',
  price_per_min_cents INT NOT NULL,       -- e.g. 50 = 0.50 KWD if cents means fils-like
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_rates_prefix
ON call_rates(prefix);

-- Call sessions
CREATE TABLE IF NOT EXISTS call_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  to_phone_e164 VARCHAR(32) NOT NULL,
  rate_id BIGINT REFERENCES call_rates(id),
  currency VARCHAR(8) NOT NULL DEFAULT 'KWD',
  price_per_min_cents INT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'started',  -- started|ended|charged|failed
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  duration_sec INT,
  charged_amount_cents INT,
  tx_id BIGINT REFERENCES wallet_transactions(id),
  meta JSONB
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_user
ON call_sessions(user_id, started_at DESC);


ALTER TABLE call_sessions
ADD COLUMN IF NOT EXISTS twilio_call_sid VARCHAR(100);

ALTER TABLE call_sessions
ADD COLUMN IF NOT EXISTS provider VARCHAR(50);