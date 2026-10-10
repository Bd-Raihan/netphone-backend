BEGIN;

ALTER TABLE stripe_payment_orders
ADD COLUMN IF NOT EXISTS stripe_mode VARCHAR(4)
NOT NULL DEFAULT 'test';

ALTER TABLE stripe_payment_orders
ADD CONSTRAINT stripe_order_mode_check
CHECK (stripe_mode IN ('test', 'live'));

DROP INDEX IF EXISTS ux_stripe_orders_user_request;

CREATE UNIQUE INDEX ux_stripe_orders_user_mode_request
ON stripe_payment_orders (
  user_id,
  stripe_mode,
  client_request_id
)
WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stripe_orders_mode
ON stripe_payment_orders (stripe_mode);

COMMIT;