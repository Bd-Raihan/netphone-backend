BEGIN;

-- =========================================================
-- 1. Exact Wallet Balance
-- 1 USD = 1,000,000 micro-USD
-- =========================================================

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS balance_microusd BIGINT;

UPDATE wallets
SET balance_microusd =
  COALESCE(balance_cents, 0) * 10000
WHERE balance_microusd IS NULL;

ALTER TABLE wallets
  ALTER COLUMN balance_microusd SET DEFAULT 0;

ALTER TABLE wallets
  ALTER COLUMN balance_microusd SET NOT NULL;

ALTER TABLE wallets
  DROP CONSTRAINT IF EXISTS wallets_balance_microusd_non_negative;

ALTER TABLE wallets
  ADD CONSTRAINT wallets_balance_microusd_non_negative
  CHECK (balance_microusd >= 0);


-- =========================================================
-- 2. Exact Wallet Transactions
-- =========================================================

ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS amount_microusd BIGINT,
  ADD COLUMN IF NOT EXISTS balance_after_microusd BIGINT;

UPDATE wallet_transactions
SET amount_microusd =
  COALESCE(amount_cents, 0) * 10000
WHERE amount_microusd IS NULL;

UPDATE wallet_transactions
SET balance_after_microusd =
  COALESCE(balance_after_cents, 0) * 10000
WHERE balance_after_microusd IS NULL
  AND balance_after_cents IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_micro_created
  ON wallet_transactions (
    user_id,
    created_at DESC
  );


-- =========================================================
-- 3. Stable Country-Based Wallet Estimate Rate
-- এটি actual call billing নয়।
-- শুধু Wallet card-এর estimated minutes-এর reference rate।
-- =========================================================

CREATE TABLE IF NOT EXISTS wallet_estimate_rates (
  id BIGSERIAL PRIMARY KEY,

  country_code VARCHAR(8) NOT NULL,
  country_name VARCHAR(120) NOT NULL,

  phone_prefix VARCHAR(20) NOT NULL,

  estimate_rate_usd_per_min NUMERIC(14,7) NOT NULL,

  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT wallet_estimate_rate_positive
    CHECK (estimate_rate_usd_per_min > 0),

  CONSTRAINT wallet_estimate_country_unique
    UNIQUE (country_code),

  CONSTRAINT wallet_estimate_prefix_unique
    UNIQUE (phone_prefix)
);


-- Bangladesh stable reference rate
INSERT INTO wallet_estimate_rates (
  country_code,
  country_name,
  phone_prefix,
  estimate_rate_usd_per_min,
  is_active
)
VALUES (
  'BD',
  'Bangladesh',
  '880',
  0.0251300,
  TRUE
)
ON CONFLICT (country_code)
DO UPDATE SET
  country_name = EXCLUDED.country_name,
  phone_prefix = EXCLUDED.phone_prefix,
  estimate_rate_usd_per_min =
    EXCLUDED.estimate_rate_usd_per_min,
  is_active = TRUE,
  updated_at = NOW();


-- United States stable reference rate
INSERT INTO wallet_estimate_rates (
  country_code,
  country_name,
  phone_prefix,
  estimate_rate_usd_per_min,
  is_active
)
VALUES (
  'US',
  'United States',
  '1',
  0.0070000,
  TRUE
)
ON CONFLICT (country_code)
DO UPDATE SET
  country_name = EXCLUDED.country_name,
  phone_prefix = EXCLUDED.phone_prefix,
  estimate_rate_usd_per_min =
    EXCLUDED.estimate_rate_usd_per_min,
  is_active = TRUE,
  updated_at = NOW();


-- Kuwait stable reference rate
INSERT INTO wallet_estimate_rates (
  country_code,
  country_name,
  phone_prefix,
  estimate_rate_usd_per_min,
  is_active
)
VALUES (
  'KW',
  'Kuwait',
  '965',
  0.0400000,
  TRUE
)
ON CONFLICT (country_code)
DO UPDATE SET
  country_name = EXCLUDED.country_name,
  phone_prefix = EXCLUDED.phone_prefix,
  estimate_rate_usd_per_min =
    EXCLUDED.estimate_rate_usd_per_min,
  is_active = TRUE,
  updated_at = NOW();


COMMENT ON COLUMN wallets.balance_microusd IS
  'Primary exact wallet balance. 1 USD = 1,000,000 micro-USD.';

COMMENT ON COLUMN wallet_transactions.amount_microusd IS
  'Exact transaction amount. 1 USD = 1,000,000 micro-USD.';

COMMENT ON TABLE wallet_estimate_rates IS
  'Stable country-based rates used only for wallet estimated minutes display.';

COMMIT;