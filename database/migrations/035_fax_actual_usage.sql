BEGIN;
-- Only Fax tables. Keep old invoices and all Calling/Payment tables unchanged.
ALTER TABLE netphone_fax_settings ADD COLUMN IF NOT EXISTS actual_billing BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE netphone_fax_settings ADD COLUMN IF NOT EXISTS fax_api_microusd BIGINT NOT NULL DEFAULT 7000;
ALTER TABLE netphone_fax_settings ADD COLUMN IF NOT EXISTS estimate_seconds_per_page INTEGER NOT NULL DEFAULT 120;
ALTER TABLE netphone_fax_settings ADD COLUMN IF NOT EXISTS deck_version UUID;
ALTER TABLE netphone_fax_settings ADD COLUMN IF NOT EXISTS last_usage_sync TIMESTAMPTZ;
ALTER TABLE netphone_fax_settings ADD COLUMN IF NOT EXISTS usage_sync_error TEXT;
ALTER TABLE netphone_fax_settings ADD COLUMN IF NOT EXISTS adapter_verified BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE netphone_fax_settings SET billing_enabled=FALSE;
CREATE TABLE IF NOT EXISTS netphone_fax_deck (
 version UUID NOT NULL, ordinal INTEGER NOT NULL, prefix VARCHAR(15) NOT NULL,
 route JSONB NOT NULL, PRIMARY KEY(version,ordinal)
);
CREATE INDEX IF NOT EXISTS netphone_fax_deck_lookup ON netphone_fax_deck(version,prefix);
CREATE TABLE IF NOT EXISTS netphone_fax_usage (
 kind VARCHAR(4) NOT NULL CHECK(kind IN ('fax','sip')), record_key TEXT NOT NULL,
 session_id UUID NOT NULL, fax_provider_id TEXT, direction VARCHAR(10) NOT NULL,
 from_number VARCHAR(15) NOT NULL, to_number VARCHAR(15) NOT NULL,
 cost_microusd BIGINT NOT NULL CHECK(cost_microusd>=0), connection_id TEXT NOT NULL,
 source VARCHAR(8) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(kind,record_key)
);
CREATE INDEX IF NOT EXISTS netphone_fax_usage_session ON netphone_fax_usage(session_id);
ALTER TABLE netphone_fax_billing ADD COLUMN IF NOT EXISTS actual_settled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE netphone_fax_billing ADD COLUMN IF NOT EXISTS provider_cost_microusd BIGINT;
ALTER TABLE netphone_fax_billing ADD COLUMN IF NOT EXISTS target_charge_microusd BIGINT;
ALTER TABLE netphone_fax_billing ADD COLUMN IF NOT EXISTS operator_shortfall_microusd BIGINT NOT NULL DEFAULT 0;
ALTER TABLE netphone_fax_billing ADD COLUMN IF NOT EXISTS billing_note TEXT;
COMMIT;
