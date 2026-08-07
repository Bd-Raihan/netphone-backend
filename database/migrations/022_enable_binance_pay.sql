BEGIN;

UPDATE payment_provider_configs
SET
    is_enabled = TRUE
WHERE provider = 'binance_pay';

UPDATE crypto_payment_methods
SET
    is_enabled = TRUE
WHERE provider = 'binance_pay';

COMMIT;