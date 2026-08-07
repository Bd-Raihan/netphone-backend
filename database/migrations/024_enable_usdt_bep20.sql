BEGIN;

UPDATE crypto_payment_methods
SET
    deposit_address = '0x3ce914ae82a29fb03c162d03d8b873a178b4bdaf',
    minimum_amount_usd = 5.00,
    maximum_amount_usd = 500.00,
    required_confirmations = 1,
    is_enabled = TRUE,
    is_primary = FALSE,
    settings =
        COALESCE(settings, '{}'::jsonb)
        || '{
             "tx_hash_required": true
           }'::jsonb
WHERE provider = 'binance_onchain'
  AND asset = 'USDT'
  AND network = 'BEP20';

COMMIT;