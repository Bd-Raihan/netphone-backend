-- =========================================================
-- 011_call_rate_engine_v3.sql
-- Call Rate Engine V3
-- Telnyx live cost + profit margin + manual override support
-- =========================================================

ALTER TABLE call_rates
ADD COLUMN IF NOT EXISTS country_name VARCHAR(100),
ADD COLUMN IF NOT EXISTS provider VARCHAR(50) DEFAULT 'telnyx',
ADD COLUMN IF NOT EXISTS provider_rate_usd_per_min NUMERIC(10,5),
ADD COLUMN IF NOT EXISTS sell_rate_usd_per_min NUMERIC(10,5),
ADD COLUMN IF NOT EXISTS markup_percent NUMERIC(6,2) DEFAULT 45.00,
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
  provider = 'telnyx',
  provider_rate_usd_per_min = COALESCE(provider_rate_usd_per_min, price_per_min_cents / 100.0),
  sell_rate_usd_per_min = COALESCE(sell_rate_usd_per_min, price_per_min_cents / 100.0),
  markup_percent = COALESCE(markup_percent, 45.00),
  min_profit_usd_per_min = COALESCE(min_profit_usd_per_min, 0.00200),
  manual_override = COALESCE(manual_override, false),
  rate_source = COALESCE(rate_source, 'manual'),
  updated_at = NOW();

-- Existing automatic Telnyx rates-কে 45% markup অনুযায়ী update করা
UPDATE call_rates
SET
  markup_percent = 45.00,

  sell_rate_usd_per_min = ROUND(
    GREATEST(
      provider_rate_usd_per_min * 1.45,
      provider_rate_usd_per_min +
        COALESCE(min_profit_usd_per_min, 0.00200)
    ),
    5
  ),

  price_per_min_cents = GREATEST(
    1,
    CEIL(
      GREATEST(
        provider_rate_usd_per_min * 1.45,
        provider_rate_usd_per_min +
          COALESCE(min_profit_usd_per_min, 0.00200)
      ) * 100
    )::INTEGER
  ),

  updated_at = NOW()

WHERE provider = 'telnyx'
  AND manual_override = false
  AND provider_rate_usd_per_min IS NOT NULL
  AND provider_rate_usd_per_min > 0;
CREATE INDEX IF NOT EXISTS idx_call_rates_prefix_active
ON call_rates(prefix, is_active);
CREATE INDEX IF NOT EXISTS idx_call_rates_country_code
ON call_rates(country_code);