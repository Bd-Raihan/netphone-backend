BEGIN;

-- ============================================================
-- NetPhone Payment Engine
-- Enable Binance On-chain USDT / TRC20 as the primary method
-- ============================================================

-- Disable every Binance On-chain method first.
UPDATE crypto_payment_methods
SET
    is_enabled = FALSE,
    is_primary = FALSE,
    updated_at = NOW()
WHERE provider = 'binance_onchain';

-- Configure and enable only USDT / TRC20.
UPDATE crypto_payment_methods
SET
    deposit_address = 'TDZm6J9kfDaNQrvg17c7FeoSjuacB2LfmX',
    destination_tag = NULL,
    minimum_amount_usd = 5.00,
    maximum_amount_usd = 500.00,
    required_confirmations = 1,
    is_enabled = TRUE,
    is_primary = TRUE,
    updated_at = NOW()
WHERE provider = 'binance_onchain'
  AND asset = 'USDT'
  AND network = 'TRC20';

-- Fail safely if the expected payment-method row does not exist.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM crypto_payment_methods
        WHERE provider = 'binance_onchain'
          AND asset = 'USDT'
          AND network = 'TRC20'
          AND deposit_address = 'TDZm6J9kfDaNQrvg17c7FeoSjuacB2LfmX'
          AND is_enabled = TRUE
          AND is_primary = TRUE
    ) THEN
        RAISE EXCEPTION
            'Unable to configure Binance On-chain USDT/TRC20 payment method';
    END IF;
END
$$;

-- Enable the automatic Binance On-chain provider.
UPDATE payment_provider_configs
SET
    is_enabled = TRUE,
    is_automatic = TRUE,
    updated_at = NOW()
WHERE provider = 'binance_onchain';

-- Keep Binance Pay disabled until Phase-21.
UPDATE payment_provider_configs
SET
    is_enabled = FALSE,
    updated_at = NOW()
WHERE provider = 'binance_pay';

-- Keep the existing manual crypto fallback enabled.
UPDATE payment_provider_configs
SET
    is_enabled = TRUE,
    is_automatic = FALSE,
    updated_at = NOW()
WHERE provider = 'manual_crypto';

COMMIT;