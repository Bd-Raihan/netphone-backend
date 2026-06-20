-- =========================================================
-- 011_call_rate_engine_v3.sql
-- Call Rate Engine V3
-- Twilio live cost + profit margin + manual override support
-- =========================================================

ALTER TABLE call_rates
ADD COLUMN IF NOT EXISTS country_name VARCHAR(100),
ADD COLUMN IF NOT EXISTS provider VARCHAR(50) DEFAULT 'twilio',
ADD COLUMN IF NOT EXISTS provider_rate_usd_per_min NUMERIC(10,5),
ADD COLUMN IF NOT EXISTS sell_rate_usd_per_min NUMERIC(10,5),
ADD COLUMN IF NOT EXISTS markup_percent NUMERIC(6,2) DEFAULT 25.00,
ADD COLUMN IF NOT EXISTS min_profit_usd_per_min NUMERIC(10,5) DEFAULT 0.00200,
ADD COLUMN IF NOT EXISTS manual_override BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS rate_source VARCHAR(50) DEFAULT 'manual',
ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

ALTER TABLE call_sessions
ADD COLUMN IF NOT EXISTS provider_rate_usd_per_min NUMERIC(10,5),
ADD COLUMN IF NOT EXISTS sell_rate_usd_per_min NUMERIC(10,5),
ADD COLUMN IF NOT EXISTS provider_cost_usd NUMERIC(10,5),
ADD COLUMN IF NOT EXISTS charged_amount_usd NUMERIC(10,5),
ADD COLUMN IF NOT EXISTS profit_usd NUMERIC(10,5);

-- পুরনো ৬ দেশকে Decimal V3 compatible করা
UPDATE call_rates
SET
  provider = 'twilio',
  provider_rate_usd_per_min = COALESCE(provider_rate_usd_per_min, price_per_min_cents / 100.0),
  sell_rate_usd_per_min = COALESCE(sell_rate_usd_per_min, price_per_min_cents / 100.0),
  markup_percent = COALESCE(markup_percent, 25.00),
  min_profit_usd_per_min = COALESCE(min_profit_usd_per_min, 0.00200),
  manual_override = COALESCE(manual_override, false),
  rate_source = COALESCE(rate_source, 'manual'),
  updated_at = NOW();

CREATE INDEX IF NOT EXISTS idx_call_rates_prefix_active
ON call_rates(prefix, is_active);

CREATE INDEX IF NOT EXISTS idx_call_rates_country_code
ON call_rates(country_code);

CREATE INDEX IF NOT EXISTS idx_call_sessions_twilio_sid
ON call_sessions(twilio_call_sid);