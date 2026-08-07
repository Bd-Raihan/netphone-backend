BEGIN;

-- ============================================================
-- NetPhone
-- Enable quoted volatile crypto payment methods
--
-- IMPORTANT:
-- Run this migration ONLY AFTER the Dynamic Crypto Quote Engine
-- is deployed and tested successfully.
-- ============================================================

UPDATE crypto_payment_methods
SET
    is_enabled = TRUE,
    settings =
        COALESCE(settings, '{}'::jsonb)
        || '{
             "tx_hash_required": true,
             "quote_required": true,
             "quote_currency": "USDT"
           }'::jsonb,
    updated_at = NOW()
WHERE provider = 'binance_onchain'
  AND (
        (asset = 'BTC' AND network = 'BTC')
        OR
        (asset = 'LTC' AND network = 'LTC')
        OR
        (asset = 'SOL' AND network = 'SOL')
        OR
        (asset = 'ETH' AND network = 'ERC20')
      );

-- Safety check:
-- Exactly four volatile-asset methods must now be enabled.
DO $$
DECLARE
    enabled_count INTEGER;
BEGIN
    SELECT COUNT(*)
    INTO enabled_count
    FROM crypto_payment_methods
    WHERE provider = 'binance_onchain'
      AND is_enabled = TRUE
      AND (
            (asset = 'BTC' AND network = 'BTC')
            OR
            (asset = 'LTC' AND network = 'LTC')
            OR
            (asset = 'SOL' AND network = 'SOL')
            OR
            (asset = 'ETH' AND network = 'ERC20')
          );

    IF enabled_count <> 4 THEN
        RAISE EXCEPTION
            'Expected 4 quoted multi-coin methods, found %',
            enabled_count;
    END IF;
END
$$;

COMMIT;