BEGIN;

-- Production-specific Binance Pay recipient.
-- IMPORTANT:
-- Replace YOUR_BINANCE_PAY_ID only on the VPS copy before execution.
-- Do not commit the real Pay ID to Git.

UPDATE crypto_payment_methods
SET
    deposit_address = 'YOUR_BINANCE_PAY_ID',
    settings =
        COALESCE(settings, '{}'::jsonb)
        || '{
             "transaction_id_required": true,
             "recipient_type": "pay_id"
           }'::jsonb
WHERE provider = 'binance_pay'
  AND asset = 'USDT'
  AND network = 'BINANCE_PAY';

COMMIT;