BEGIN;

-- =====================================================================
-- 019_payment_engine_core.sql
--
-- NetPhone Payment Engine Core
-- Current scope only:
--   1) manual_crypto      (existing fallback)
--   2) binance_onchain   (new)
--   3) binance_pay       (new, separate provider)
--
-- Wallet source of truth:
--   1 USD = 1,000,000 micro-USD
--
-- This migration does NOT add:
--   - Card processor
--   - Google Pay
--   - Checkout.com
-- =====================================================================


-- =====================================================================
-- 1. PAYMENT ORDERS
-- One row = one recharge/payment order.
-- Wallet credit must happen at most once per order.
-- =====================================================================

CREATE TABLE IF NOT EXISTS payment_orders (
  id BIGSERIAL PRIMARY KEY,

  order_reference VARCHAR(80) NOT NULL,

  user_id BIGINT NOT NULL
    REFERENCES users(id)
    ON DELETE CASCADE,

  provider VARCHAR(30) NOT NULL,

  payment_type VARCHAR(30) NOT NULL
    DEFAULT 'crypto_recharge',

  requested_amount_usd NUMERIC(20,8) NOT NULL,

  requested_amount_microusd BIGINT NOT NULL,

  asset VARCHAR(20),

  network VARCHAR(40),

  expected_crypto_amount NUMERIC(36,18),

  destination_address TEXT,

  destination_tag TEXT,

  provider_order_id TEXT,

  provider_transaction_id TEXT,

  tx_hash TEXT,

  status VARCHAR(30) NOT NULL
    DEFAULT 'created',

  wallet_tx_id BIGINT
    REFERENCES wallet_transactions(id)
    ON DELETE SET NULL,

  manual_recharge_request_id BIGINT
    REFERENCES crypto_recharge_requests(id)
    ON DELETE SET NULL,

  expires_at TIMESTAMPTZ,

  payment_detected_at TIMESTAMPTZ,

  paid_at TIMESTAMPTZ,

  credited_at TIMESTAMPTZ,

  failed_at TIMESTAMPTZ,

  failure_code VARCHAR(100),

  failure_message TEXT,

  metadata JSONB NOT NULL
    DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL
    DEFAULT NOW(),

  updated_at TIMESTAMPTZ NOT NULL
    DEFAULT NOW(),

  CONSTRAINT payment_orders_order_reference_unique
    UNIQUE (order_reference),

  CONSTRAINT payment_orders_provider_check
    CHECK (
      provider IN (
        'manual_crypto',
        'binance_onchain',
        'binance_pay'
      )
    ),

  CONSTRAINT payment_orders_type_check
    CHECK (
      payment_type = 'crypto_recharge'
    ),

  CONSTRAINT payment_orders_requested_usd_positive
    CHECK (
      requested_amount_usd > 0
    ),

  CONSTRAINT payment_orders_requested_microusd_positive
    CHECK (
      requested_amount_microusd > 0
    ),

  CONSTRAINT payment_orders_expected_crypto_positive
    CHECK (
      expected_crypto_amount IS NULL
      OR expected_crypto_amount > 0
    ),

  CONSTRAINT payment_orders_status_check
    CHECK (
      status IN (
        'created',
        'awaiting_payment',
        'payment_detected',
        'confirming',
        'paid',
        'credited',
        'expired',
        'cancelled',
        'failed',
        'manual_review',
        'rejected'
      )
    ),

  CONSTRAINT payment_orders_credit_state_check
    CHECK (
      (
        status = 'credited'
        AND wallet_tx_id IS NOT NULL
        AND credited_at IS NOT NULL
      )
      OR
      (
        status <> 'credited'
      )
    )
);


-- One wallet transaction cannot credit multiple payment orders.
CREATE UNIQUE INDEX IF NOT EXISTS
  ux_payment_orders_wallet_tx
ON payment_orders (wallet_tx_id)
WHERE wallet_tx_id IS NOT NULL;


-- Provider-side order ID must not be processed twice.
CREATE UNIQUE INDEX IF NOT EXISTS
  ux_payment_orders_provider_order_id
ON payment_orders (
  provider,
  provider_order_id
)
WHERE provider_order_id IS NOT NULL;


-- Provider-side transaction ID must not be processed twice.
CREATE UNIQUE INDEX IF NOT EXISTS
  ux_payment_orders_provider_transaction_id
ON payment_orders (
  provider,
  provider_transaction_id
)
WHERE provider_transaction_id IS NOT NULL;


-- Blockchain TX hash is case-normalized to prevent duplicate/replay credit.
CREATE UNIQUE INDEX IF NOT EXISTS
  ux_payment_orders_provider_tx_hash
ON payment_orders (
  provider,
  LOWER(tx_hash)
)
WHERE tx_hash IS NOT NULL;


CREATE INDEX IF NOT EXISTS
  idx_payment_orders_user_created
ON payment_orders (
  user_id,
  created_at DESC
);


CREATE INDEX IF NOT EXISTS
  idx_payment_orders_status_created
ON payment_orders (
  status,
  created_at ASC
);


CREATE INDEX IF NOT EXISTS
  idx_payment_orders_provider_status
ON payment_orders (
  provider,
  status,
  created_at ASC
);


CREATE INDEX IF NOT EXISTS
  idx_payment_orders_reconciliation
ON payment_orders (
  provider,
  status,
  updated_at ASC
)
WHERE status IN (
  'awaiting_payment',
  'payment_detected',
  'confirming',
  'paid',
  'manual_review'
);


-- =====================================================================
-- 2. DEDICATED CRYPTO TRANSACTION HISTORY
--
-- This is separate from wallet_transactions.
--
-- wallet_transactions:
--   Final money movement inside NetPhone wallet.
--
-- crypto_transaction_history:
--   Complete crypto lifecycle:
--   order created, TX submitted, Binance detected, confirmations,
--   verification failed, paid, wallet credited, rejected, etc.
-- =====================================================================

CREATE TABLE IF NOT EXISTS crypto_transaction_history (
  id BIGSERIAL PRIMARY KEY,

  payment_order_id BIGINT NOT NULL
    REFERENCES payment_orders(id)
    ON DELETE CASCADE,

  user_id BIGINT NOT NULL
    REFERENCES users(id)
    ON DELETE CASCADE,

  provider VARCHAR(30) NOT NULL,

  event_key VARCHAR(160) NOT NULL,

  event_type VARCHAR(40) NOT NULL,

  order_status VARCHAR(30),

  asset VARCHAR(20),

  network VARCHAR(40),

  crypto_amount NUMERIC(36,18),

  usd_amount NUMERIC(20,8),

  amount_microusd BIGINT,

  tx_hash TEXT,

  provider_order_id TEXT,

  provider_transaction_id TEXT,

  confirmations INTEGER,

  required_confirmations INTEGER,

  from_address TEXT,

  to_address TEXT,

  verification_result VARCHAR(30),

  note TEXT,

  raw_payload JSONB NOT NULL
    DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL
    DEFAULT NOW(),

  CONSTRAINT crypto_tx_history_provider_check
    CHECK (
      provider IN (
        'manual_crypto',
        'binance_onchain',
        'binance_pay'
      )
    ),

  CONSTRAINT crypto_tx_history_event_type_check
    CHECK (
      event_type IN (
        'order_created',
        'awaiting_payment',
        'tx_submitted',
        'deposit_detected',
        'confirmation_updated',
        'verification_passed',
        'verification_failed',
        'payment_paid',
        'wallet_credited',
        'manual_review',
        'approved',
        'rejected',
        'expired',
        'cancelled',
        'failed'
      )
    ),

  CONSTRAINT crypto_tx_history_order_status_check
    CHECK (
      order_status IS NULL
      OR order_status IN (
        'created',
        'awaiting_payment',
        'payment_detected',
        'confirming',
        'paid',
        'credited',
        'expired',
        'cancelled',
        'failed',
        'manual_review',
        'rejected'
      )
    ),

  CONSTRAINT crypto_tx_history_crypto_amount_positive
    CHECK (
      crypto_amount IS NULL
      OR crypto_amount > 0
    ),

  CONSTRAINT crypto_tx_history_usd_amount_positive
    CHECK (
      usd_amount IS NULL
      OR usd_amount > 0
    ),

  CONSTRAINT crypto_tx_history_microusd_positive
    CHECK (
      amount_microusd IS NULL
      OR amount_microusd > 0
    ),

  CONSTRAINT crypto_tx_history_confirmations_non_negative
    CHECK (
      confirmations IS NULL
      OR confirmations >= 0
    ),

  CONSTRAINT crypto_tx_history_required_confirmations_non_negative
    CHECK (
      required_confirmations IS NULL
      OR required_confirmations >= 0
    ),

  CONSTRAINT crypto_tx_history_verification_result_check
    CHECK (
      verification_result IS NULL
      OR verification_result IN (
        'pending',
        'passed',
        'failed',
        'manual_review'
      )
    ),

  CONSTRAINT crypto_tx_history_event_unique
    UNIQUE (
      provider,
      event_key
    )
);


CREATE INDEX IF NOT EXISTS
  idx_crypto_tx_history_user_created
ON crypto_transaction_history (
  user_id,
  created_at DESC
);


CREATE INDEX IF NOT EXISTS
  idx_crypto_tx_history_order_created
ON crypto_transaction_history (
  payment_order_id,
  created_at ASC
);


CREATE INDEX IF NOT EXISTS
  idx_crypto_tx_history_tx_hash
ON crypto_transaction_history (
  LOWER(tx_hash)
)
WHERE tx_hash IS NOT NULL;


CREATE INDEX IF NOT EXISTS
  idx_crypto_tx_history_provider_event
ON crypto_transaction_history (
  provider,
  event_type,
  created_at DESC
);


-- =====================================================================
-- 3. LINK EXISTING MANUAL CRYPTO REQUESTS TO PAYMENT ENGINE
--
-- Existing rows remain untouched.
-- New manual requests can be linked to a payment order.
-- =====================================================================

ALTER TABLE crypto_recharge_requests
  ADD COLUMN IF NOT EXISTS payment_order_id BIGINT;


DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'crypto_recharge_requests_payment_order_id_fkey'
  ) THEN
    ALTER TABLE crypto_recharge_requests
      ADD CONSTRAINT
        crypto_recharge_requests_payment_order_id_fkey
      FOREIGN KEY (payment_order_id)
      REFERENCES payment_orders(id)
      ON DELETE SET NULL;
  END IF;
END
$$;


CREATE UNIQUE INDEX IF NOT EXISTS
  ux_crypto_recharge_requests_payment_order
ON crypto_recharge_requests (
  payment_order_id
)
WHERE payment_order_id IS NOT NULL;


-- Existing table had no database-level duplicate TX protection.
-- This protects future non-null transaction hashes.
CREATE UNIQUE INDEX IF NOT EXISTS
  ux_crypto_recharge_requests_tx_hash
ON crypto_recharge_requests (
  LOWER(tx_hash)
)
WHERE tx_hash IS NOT NULL
  AND BTRIM(tx_hash) <> '';


-- =====================================================================
-- 4. UPDATED_AT TRIGGER
-- =====================================================================

CREATE OR REPLACE FUNCTION
  set_payment_order_updated_at_019()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS
  trg_payment_orders_updated_at
ON payment_orders;


CREATE TRIGGER
  trg_payment_orders_updated_at
BEFORE UPDATE
ON payment_orders
FOR EACH ROW
EXECUTE FUNCTION
  set_payment_order_updated_at_019();


-- =====================================================================
-- 5. DOCUMENTATION
-- =====================================================================

COMMENT ON TABLE payment_orders IS
  'NetPhone crypto payment orders for manual crypto, Binance on-chain, and Binance Pay only.';

COMMENT ON COLUMN payment_orders.requested_amount_microusd IS
  'Exact requested wallet credit. 1 USD = 1,000,000 micro-USD.';

COMMENT ON COLUMN payment_orders.wallet_tx_id IS
  'Final wallet_transactions row. Must be set only after verified, idempotent wallet credit.';

COMMENT ON COLUMN payment_orders.tx_hash IS
  'Blockchain transaction hash. Unique per provider after case normalization.';

COMMENT ON TABLE crypto_transaction_history IS
  'Dedicated immutable-style crypto lifecycle history, separate from the NetPhone wallet ledger.';

COMMENT ON COLUMN crypto_transaction_history.event_key IS
  'Application-generated idempotency key for one crypto history event.';

COMMENT ON COLUMN crypto_transaction_history.raw_payload IS
  'Sanitized provider/API response snapshot. Secrets must never be stored here.';

COMMENT ON COLUMN crypto_recharge_requests.payment_order_id IS
  'Optional link from the legacy manual crypto request to the new Payment Engine order.';


COMMIT;
