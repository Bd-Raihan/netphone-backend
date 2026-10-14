BEGIN;
-- Additive Fax-only migration. Do not rerun migration 035.
CREATE TABLE IF NOT EXISTS netphone_fax_price_controls (
 id UUID PRIMARY KEY, country_code VARCHAR(2) NOT NULL, country_name VARCHAR(100) NOT NULL,
 phone_prefix VARCHAR(15) NOT NULL CHECK(phone_prefix ~ '^[1-9][0-9]{0,14}$'),
 direction VARCHAR(10) NOT NULL CHECK(direction IN ('inbound','outbound')),
 minimum_page_microusd BIGINT NOT NULL CHECK(minimum_page_microusd BETWEEN 0 AND 100000000),
 active BOOLEAN NOT NULL DEFAULT TRUE, updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(direction,phone_prefix)
);
ALTER TABLE netphone_fax_usage ADD COLUMN IF NOT EXISTS usage_details JSONB NOT NULL DEFAULT '{}';
ALTER TABLE netphone_fax_billing ADD COLUMN IF NOT EXISTS billing_details JSONB NOT NULL DEFAULT '{}';
ALTER TABLE netphone_fax_billing ADD COLUMN IF NOT EXISTS reserved_microusd BIGINT;
CREATE TABLE IF NOT EXISTS netphone_fax_autopay (
 user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 enabled BOOLEAN NOT NULL DEFAULT FALSE, limit_microusd BIGINT NOT NULL DEFAULT 500000
 CHECK(limit_microusd BETWEEN 10000 AND 100000000), enabled_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMIT;
