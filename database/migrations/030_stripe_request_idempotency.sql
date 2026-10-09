
-- NetPhone Stripe request idempotency
-- Run only after migration 029 is applied.

BEGIN;

ALTER TABLE stripe_payment_orders
  ADD COLUMN IF NOT EXISTS client_request_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS
  ux_stripe_orders_user_request
ON stripe_payment_orders (user_id, client_request_id)
WHERE client_request_id IS NOT NULL;

COMMIT;
