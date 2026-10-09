
BEGIN;

-- NetPhone Stripe Card Recharge Foundation
-- New tables only. No wallet or crypto schema changes.
-- 1 USD = 1,000,000 micro-USD

CREATE TABLE stripe_payment_orders (
  id BIGSERIAL PRIMARY KEY,

  order_reference VARCHAR(80) NOT NULL UNIQUE,

  user_id BIGINT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,

  amount_cents BIGINT NOT NULL,
  amount_microusd BIGINT NOT NULL,

  currency VARCHAR(3) NOT NULL DEFAULT 'usd',

  stripe_payment_intent_id TEXT UNIQUE,

  status VARCHAR(30) NOT NULL DEFAULT 'created',
  creation_started_at TIMESTAMPTZ,

  wallet_tx_id BIGINT UNIQUE
    REFERENCES wallet_transactions(id) ON DELETE RESTRICT,

  credited_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT stripe_order_amount_check
    CHECK (
      amount_cents BETWEEN 500 AND 50000
      AND amount_microusd = amount_cents * 10000
    ),

  CONSTRAINT stripe_order_currency_check
    CHECK (currency = 'usd'),

  CONSTRAINT stripe_order_status_check
    CHECK (
      status IN (
        'created',
        'creating_intent',
        'awaiting_payment',
        'paid',
        'credited',
        'failed',
        'cancelled',
        'refunded',
        'disputed',
        'manual_review'
      )
    ),


CONSTRAINT stripe_order_credit_check
  CHECK (
    (
      wallet_tx_id IS NULL
      AND credited_at IS NULL
      AND status <> 'credited'
    )
    OR
    (
      wallet_tx_id IS NOT NULL
      AND credited_at IS NOT NULL
      AND status IN (
        'credited',
        'refunded',
        'disputed',
        'manual_review'
      )
    )
  )

);

CREATE INDEX idx_stripe_orders_user_created
  ON stripe_payment_orders(user_id, created_at DESC);

CREATE INDEX idx_stripe_orders_status_created
  ON stripe_payment_orders(status, created_at);

-- Webhook event inbox / audit trail.
CREATE TABLE stripe_payment_events (
  id BIGSERIAL PRIMARY KEY,

  stripe_event_id TEXT NOT NULL UNIQUE,

  stripe_payment_intent_id TEXT,

  stripe_order_id BIGINT
    REFERENCES stripe_payment_orders(id) ON DELETE RESTRICT,

  event_type VARCHAR(100) NOT NULL,

  processing_status VARCHAR(20) NOT NULL DEFAULT 'received',

  attempts INTEGER NOT NULL DEFAULT 0,

  last_error TEXT,

  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,

  CONSTRAINT stripe_event_processing_check
    CHECK (
      processing_status IN (
        'received',
        'processing',
        'processed',
        'failed',
        'ignored'
      )
    ),

  CONSTRAINT stripe_event_attempts_check
    CHECK (attempts >= 0)
);

CREATE INDEX idx_stripe_events_processing
  ON stripe_payment_events(processing_status, received_at);

CREATE INDEX idx_stripe_events_intent
  ON stripe_payment_events(stripe_payment_intent_id);

COMMIT;
