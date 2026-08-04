BEGIN;

CREATE TABLE IF NOT EXISTS payment_provider_configs (
  id BIGSERIAL PRIMARY KEY,
  provider VARCHAR(30) NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  priority SMALLINT NOT NULL DEFAULT 100,
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  is_automatic BOOLEAN NOT NULL DEFAULT FALSE,
  minimum_amount_usd NUMERIC(20,8) NOT NULL DEFAULT 5,
  maximum_amount_usd NUMERIC(20,8) NOT NULL DEFAULT 500,
  order_expiry_minutes INTEGER NOT NULL DEFAULT 60,
  reconciliation_interval_seconds INTEGER NOT NULL DEFAULT 30,
  max_retry_attempts INTEGER NOT NULL DEFAULT 20,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_provider_configs_provider_check CHECK (
    provider IN ('manual_crypto','binance_onchain','binance_pay')
  ),
  CONSTRAINT payment_provider_configs_amount_check CHECK (
    minimum_amount_usd > 0 AND maximum_amount_usd >= minimum_amount_usd
  ),
  CONSTRAINT payment_provider_configs_runtime_check CHECK (
    priority > 0 AND order_expiry_minutes > 0 AND
    reconciliation_interval_seconds >= 5 AND max_retry_attempts >= 0
  )
);

INSERT INTO payment_provider_configs (
  provider, display_name, priority, is_enabled, is_automatic,
  minimum_amount_usd, maximum_amount_usd, order_expiry_minutes,
  reconciliation_interval_seconds, max_retry_attempts, settings
)
VALUES
('binance_onchain','Binance On-chain',10,FALSE,TRUE,5,500,60,30,20,
 '{"mode":"deposit_history_verification","tx_hash_required":true}'::jsonb),
('binance_pay','Binance Pay',20,FALSE,TRUE,5,500,30,30,20,
 '{"mode":"transaction_history_verification","transaction_id_required":true}'::jsonb),
('manual_crypto','Manual Crypto Review',30,TRUE,FALSE,5,500,1440,300,0,
 '{"mode":"fallback_review_only"}'::jsonb)
ON CONFLICT (provider) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_payment_provider_configs_enabled_priority
ON payment_provider_configs (is_enabled, priority);

CREATE TABLE IF NOT EXISTS crypto_payment_methods (
  id BIGSERIAL PRIMARY KEY,
  provider VARCHAR(30) NOT NULL,
  asset VARCHAR(20) NOT NULL,
  network VARCHAR(40) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  deposit_address TEXT,
  destination_tag TEXT,
  minimum_amount_usd NUMERIC(20,8) NOT NULL DEFAULT 5,
  maximum_amount_usd NUMERIC(20,8) NOT NULL DEFAULT 500,
  required_confirmations INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 100,
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crypto_payment_methods_unique UNIQUE (provider, asset, network),
  CONSTRAINT crypto_payment_methods_provider_check CHECK (
    provider IN ('manual_crypto','binance_onchain','binance_pay')
  ),
  CONSTRAINT crypto_payment_methods_amount_check CHECK (
    minimum_amount_usd > 0 AND maximum_amount_usd >= minimum_amount_usd
  ),
  CONSTRAINT crypto_payment_methods_runtime_check CHECK (
    required_confirmations >= 0 AND display_order > 0
  )
);

INSERT INTO crypto_payment_methods (
  provider, asset, network, display_name,
  minimum_amount_usd, maximum_amount_usd,
  required_confirmations, display_order, is_enabled, is_primary, settings
)
VALUES
('binance_onchain','USDT','TRC20','USDT (TRON / TRC20)',5,500,1,10,FALSE,TRUE,
 '{"tx_hash_required":true}'::jsonb),
('binance_onchain','USDT','BEP20','USDT (BNB Smart Chain / BEP20)',5,500,1,20,FALSE,FALSE,
 '{"tx_hash_required":true}'::jsonb),
('binance_onchain','BTC','BTC','Bitcoin',5,500,1,30,FALSE,FALSE,
 '{"tx_hash_required":true}'::jsonb),
('binance_onchain','LTC','LTC','Litecoin',5,500,1,40,FALSE,FALSE,
 '{"tx_hash_required":true}'::jsonb),
('binance_pay','USDT','BINANCE_PAY','Binance Pay (USDT)',5,500,0,50,FALSE,TRUE,
 '{"transaction_id_required":true}'::jsonb)
ON CONFLICT (provider, asset, network) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_crypto_payment_methods_enabled_order
ON crypto_payment_methods (provider, is_enabled, display_order);

CREATE UNIQUE INDEX IF NOT EXISTS ux_crypto_payment_methods_one_primary
ON crypto_payment_methods (provider)
WHERE is_primary = TRUE AND is_enabled = TRUE;

CREATE TABLE IF NOT EXISTS payment_reconciliation_jobs (
  id BIGSERIAL PRIMARY KEY,
  payment_order_id BIGINT NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,
  provider VARCHAR(30) NOT NULL,
  job_status VARCHAR(30) NOT NULL DEFAULT 'queued',
  priority SMALLINT NOT NULL DEFAULT 100,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 20,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by VARCHAR(120),
  last_started_at TIMESTAMPTZ,
  last_finished_at TIMESTAMPTZ,
  last_error_code VARCHAR(120),
  last_error_message TEXT,
  result_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_reconciliation_jobs_order_unique UNIQUE (payment_order_id),
  CONSTRAINT payment_reconciliation_jobs_provider_check CHECK (
    provider IN ('binance_onchain','binance_pay')
  ),
  CONSTRAINT payment_reconciliation_jobs_status_check CHECK (
    job_status IN ('queued','processing','retry_wait','completed','manual_review','failed','cancelled')
  ),
  CONSTRAINT payment_reconciliation_jobs_attempt_check CHECK (
    priority > 0 AND attempt_count >= 0 AND max_attempts >= 0 AND attempt_count <= max_attempts
  )
);

CREATE INDEX IF NOT EXISTS idx_payment_reconciliation_jobs_ready
ON payment_reconciliation_jobs (priority ASC, next_attempt_at ASC, id ASC)
WHERE job_status IN ('queued','retry_wait');

CREATE INDEX IF NOT EXISTS idx_payment_reconciliation_jobs_processing
ON payment_reconciliation_jobs (locked_at ASC)
WHERE job_status = 'processing';

CREATE INDEX IF NOT EXISTS idx_payment_reconciliation_jobs_provider_status
ON payment_reconciliation_jobs (provider, job_status, next_attempt_at ASC);

ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS crypto_payment_method_id BIGINT;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS reconciliation_job_id BIGINT;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS verification_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS next_verification_at TIMESTAMPTZ;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS review_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_orders_crypto_payment_method_id_fkey'
  ) THEN
    ALTER TABLE payment_orders
      ADD CONSTRAINT payment_orders_crypto_payment_method_id_fkey
      FOREIGN KEY (crypto_payment_method_id)
      REFERENCES crypto_payment_methods(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_orders_reconciliation_job_id_fkey'
  ) THEN
    ALTER TABLE payment_orders
      ADD CONSTRAINT payment_orders_reconciliation_job_id_fkey
      FOREIGN KEY (reconciliation_job_id)
      REFERENCES payment_reconciliation_jobs(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_orders_verification_attempts_check'
  ) THEN
    ALTER TABLE payment_orders
      ADD CONSTRAINT payment_orders_verification_attempts_check
      CHECK (verification_attempts >= 0);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_payment_orders_next_verification
ON payment_orders (next_verification_at ASC)
WHERE status IN ('awaiting_payment','payment_detected','confirming','paid');

CREATE OR REPLACE FUNCTION set_payment_runtime_updated_at_020()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_provider_configs_updated_at
ON payment_provider_configs;
CREATE TRIGGER trg_payment_provider_configs_updated_at
BEFORE UPDATE ON payment_provider_configs
FOR EACH ROW EXECUTE FUNCTION set_payment_runtime_updated_at_020();

DROP TRIGGER IF EXISTS trg_crypto_payment_methods_updated_at
ON crypto_payment_methods;
CREATE TRIGGER trg_crypto_payment_methods_updated_at
BEFORE UPDATE ON crypto_payment_methods
FOR EACH ROW EXECUTE FUNCTION set_payment_runtime_updated_at_020();

DROP TRIGGER IF EXISTS trg_payment_reconciliation_jobs_updated_at
ON payment_reconciliation_jobs;
CREATE TRIGGER trg_payment_reconciliation_jobs_updated_at
BEFORE UPDATE ON payment_reconciliation_jobs
FOR EACH ROW EXECUTE FUNCTION set_payment_runtime_updated_at_020();

COMMENT ON TABLE payment_provider_configs IS
  'Dynamic runtime config for Binance On-chain, Binance Pay, and Manual Crypto Review.';
COMMENT ON TABLE crypto_payment_methods IS
  'Dynamic crypto asset/network/address list loaded from Backend.';
COMMENT ON COLUMN crypto_payment_methods.deposit_address IS
  'Server-managed destination address; never hard-code in Flutter.';
COMMENT ON TABLE payment_reconciliation_jobs IS
  'Worker-safe automatic Binance verification queue.';

COMMIT;
