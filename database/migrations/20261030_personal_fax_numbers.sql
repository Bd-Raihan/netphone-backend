BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE netphone_faxes ADD COLUMN IF NOT EXISTS provider_connection_id TEXT;
CREATE TABLE IF NOT EXISTS netphone_personal_fax_numbers (
 id UUID PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES users(id),
 request_key UUID NOT NULL,
 phone_number TEXT NOT NULL CHECK(phone_number ~ '^\+1[0-9]{10}$'),
 connection_id TEXT NOT NULL,
 provider_number_id TEXT UNIQUE,
 provider_order_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('reserved','ordering','active','release_pending','released','failed')),
 upfront_microusd BIGINT NOT NULL CHECK(upfront_microusd BETWEEN 0 AND 1000000),
 monthly_microusd BIGINT NOT NULL DEFAULT 1000000 CHECK(monthly_microusd=1000000),
 initial_periods JSONB NOT NULL,
 dispatch_started_at TIMESTAMPTZ,
 activated_at TIMESTAMPTZ,
 paid_until TIMESTAMPTZ NOT NULL,
 cancel_requested_at TIMESTAMPTZ,
 released_at TIMESTAMPTZ,
 last_checked_at TIMESTAMPTZ,
 last_notice_period TEXT,
 review_reason TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(user_id,request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS personal_fax_one_live_user ON netphone_personal_fax_numbers(user_id)
 WHERE state NOT IN ('released','failed');
CREATE UNIQUE INDEX IF NOT EXISTS personal_fax_one_live_number ON netphone_personal_fax_numbers(phone_number)
 WHERE state NOT IN ('released','failed');
CREATE INDEX IF NOT EXISTS personal_fax_worker ON netphone_personal_fax_numbers(state,last_checked_at);
CREATE INDEX IF NOT EXISTS personal_fax_renewal_due ON netphone_personal_fax_numbers(paid_until) WHERE state='active';
CREATE INDEX IF NOT EXISTS personal_fax_destination ON netphone_personal_fax_numbers(phone_number,created_at);
CREATE TABLE IF NOT EXISTS netphone_personal_fax_periods (
 number_id UUID NOT NULL REFERENCES netphone_personal_fax_numbers(id),
 period_start TIMESTAMPTZ NOT NULL,
 period_end TIMESTAMPTZ NOT NULL CHECK(period_end>period_start),
 amount_microusd BIGINT NOT NULL CHECK(amount_microusd BETWEEN 1 AND 1000000),
 refunded BOOLEAN NOT NULL DEFAULT FALSE,
 PRIMARY KEY(number_id,period_start)
);
CREATE TABLE IF NOT EXISTS netphone_personal_fax_events (
 fax_id UUID PRIMARY KEY,
 media_url TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 completed_at TIMESTAMPTZ,
 attempts INTEGER NOT NULL DEFAULT 0,
 review_reason TEXT
);
CREATE INDEX IF NOT EXISTS personal_fax_events_pending ON netphone_personal_fax_events(next_attempt_at)
 WHERE completed_at IS NULL;
CREATE TABLE IF NOT EXISTS netphone_personal_fax_audit (
 id BIGSERIAL PRIMARY KEY,
 number_id UUID NOT NULL REFERENCES netphone_personal_fax_numbers(id),
 actor_user_id BIGINT REFERENCES users(id),
 action TEXT NOT NULL,
 details JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='netphone_user') THEN
  GRANT SELECT,INSERT,UPDATE ON netphone_personal_fax_numbers,netphone_personal_fax_periods,netphone_personal_fax_events TO netphone_user;
  GRANT SELECT,INSERT ON netphone_personal_fax_audit TO netphone_user;
  GRANT USAGE,SELECT ON SEQUENCE netphone_personal_fax_audit_id_seq TO netphone_user;
 END IF;
END $$;
COMMIT;
