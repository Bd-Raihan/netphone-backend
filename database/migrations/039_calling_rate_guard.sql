BEGIN;
-- Calling-only additive schema. No Fax or historical wallet mutations.
CREATE TABLE IF NOT EXISTS voice_guard_settings (
 id INTEGER PRIMARY KEY CHECK(id=1),enabled BOOLEAN NOT NULL DEFAULT FALSE,
 deck_version UUID,source_name TEXT,source_sha256 TEXT,imported_at TIMESTAMPTZ,caller_number TEXT,
 default_markup NUMERIC(6,2) NOT NULL DEFAULT 30 CHECK(default_markup BETWEEN 0 AND 1000),
 sdk_microusd BIGINT NOT NULL DEFAULT 2000 CHECK(sdk_microusd>=0),
 max_deck_age_days INTEGER NOT NULL DEFAULT 30 CHECK(max_deck_age_days BETWEEN 1 AND 90),
 last_monitor_sync TIMESTAMPTZ,monitor_error TEXT,monitor_verified BOOLEAN NOT NULL DEFAULT FALSE
);
INSERT INTO voice_guard_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS voice_guard_deck (
 version UUID NOT NULL,ordinal INTEGER NOT NULL,fixed_prefix VARCHAR(15) NOT NULL,
 iso TEXT NOT NULL,country TEXT NOT NULL,eligible BOOLEAN NOT NULL,route JSONB NOT NULL,
 PRIMARY KEY(version,ordinal)
);
CREATE INDEX IF NOT EXISTS voice_guard_prefix ON voice_guard_deck(version,fixed_prefix);
CREATE INDEX IF NOT EXISTS voice_guard_country ON voice_guard_deck(version,iso) WHERE eligible;
CREATE TABLE IF NOT EXISTS voice_guard_policies (
 prefix VARCHAR(15) NOT NULL CHECK(prefix ~ '^[1-9][0-9]{0,14}$'),country_code TEXT NOT NULL,
 scope TEXT NOT NULL DEFAULT 'country' CHECK(scope IN ('country','prefix')),
 pricing_mode TEXT NOT NULL CHECK(pricing_mode IN ('auto_markup','manual_rate')),
 markup_percent NUMERIC(6,2) NOT NULL DEFAULT 30 CHECK(markup_percent BETWEEN 0 AND 1000),
 manual_sell_rate_usd_per_min NUMERIC(14,6) CHECK(manual_sell_rate_usd_per_min>0),
 is_active BOOLEAN NOT NULL DEFAULT TRUE,note TEXT,updated_by BIGINT REFERENCES users(id),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(prefix,country_code,scope)
);
CREATE INDEX IF NOT EXISTS voice_guard_policy_country ON voice_guard_policies(country_code,scope);
CREATE TABLE IF NOT EXISTS voice_guard_audit (
 id BIGSERIAL PRIMARY KEY,actor_user_id BIGINT REFERENCES users(id),action TEXT NOT NULL,
 details JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS voice_guard_usage (
 kind TEXT NOT NULL CHECK(kind IN ('sip-trunking','webrtc','call-control')),record_key TEXT NOT NULL,
 session_uuid UUID NOT NULL,leg_id TEXT,connection_id TEXT NOT NULL,from_number TEXT NOT NULL,to_number TEXT NOT NULL,
 cost_microusd BIGINT NOT NULL CHECK(cost_microusd>=0),billed_seconds BIGINT NOT NULL CHECK(billed_seconds>=0),
 rate_microusd BIGINT,direction TEXT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(kind,record_key)
);
CREATE INDEX IF NOT EXISTS voice_guard_usage_session ON voice_guard_usage(session_uuid);
CREATE TABLE IF NOT EXISTS voice_guard_actuals (
 session_id BIGINT PRIMARY KEY REFERENCES call_sessions(id),country_code TEXT NOT NULL,prefix TEXT NOT NULL,
 provider_microusd BIGINT NOT NULL,wallet_microusd BIGINT NOT NULL,profit_microusd BIGINT NOT NULL,
 cost_status TEXT NOT NULL DEFAULT 'partial',updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS voice_guard_alerts (
 alert_key TEXT PRIMARY KEY,country_code TEXT NOT NULL DEFAULT '',prefix TEXT NOT NULL DEFAULT '',
 severity TEXT NOT NULL CHECK(severity IN ('loss','warning')),message TEXT NOT NULL,
 details JSONB NOT NULL DEFAULT '{}',active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 resolved_at TIMESTAMPTZ,resolved_by BIGINT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS voice_guard_active_alerts ON voice_guard_alerts(country_code) WHERE active;
COMMIT;
