BEGIN;

-- ============================================================
-- NetPhone Multi-Coin Production Configuration
-- BTC / LTC / SOL / ETH
--
-- IMPORTANT:
-- These methods are configured here but intentionally kept
-- disabled until Dynamic Crypto Quote Engine is enabled.
-- ============================================================


-- ------------------------------------------------------------
-- BTC / Bitcoin
-- Existing row থাকলে update হবে, না থাকলে create হবে.
-- ------------------------------------------------------------
INSERT INTO crypto_payment_methods (
    provider,
    asset,
    network,
    display_name,
    deposit_address,
    destination_tag,
    minimum_amount_usd,
    maximum_amount_usd,
    required_confirmations,
    display_order,
    is_enabled,
    is_primary,
    settings
)
VALUES (
    'binance_onchain',
    'BTC',
    'BTC',
    'Bitcoin (BTC)',
    '13iJq1AMtAUpDDtMioPZdNYSfvyeRbRNNX',
    NULL,
    5.00,
    500.00,
    1,
    30,
    FALSE,
    FALSE,
    '{"tx_hash_required": true, "quote_required": true}'::jsonb
)
ON CONFLICT (provider, asset, network)
DO UPDATE SET
    display_name = EXCLUDED.display_name,
    deposit_address = EXCLUDED.deposit_address,
    destination_tag = EXCLUDED.destination_tag,
    minimum_amount_usd = EXCLUDED.minimum_amount_usd,
    maximum_amount_usd = EXCLUDED.maximum_amount_usd,
    required_confirmations = EXCLUDED.required_confirmations,
    display_order = EXCLUDED.display_order,
    is_enabled = FALSE,
    is_primary = FALSE,
    settings =
        COALESCE(crypto_payment_methods.settings, '{}'::jsonb)
        || EXCLUDED.settings,
    updated_at = NOW();


-- ------------------------------------------------------------
-- LTC / Litecoin
-- ------------------------------------------------------------
INSERT INTO crypto_payment_methods (
    provider,
    asset,
    network,
    display_name,
    deposit_address,
    destination_tag,
    minimum_amount_usd,
    maximum_amount_usd,
    required_confirmations,
    display_order,
    is_enabled,
    is_primary,
    settings
)
VALUES (
    'binance_onchain',
    'LTC',
    'LTC',
    'Litecoin (LTC)',
    'LNbGkgJzoHaGhY1BArfwRp9id1PsmehcLn',
    NULL,
    5.00,
    500.00,
    1,
    40,
    FALSE,
    FALSE,
    '{"tx_hash_required": true, "quote_required": true}'::jsonb
)
ON CONFLICT (provider, asset, network)
DO UPDATE SET
    display_name = EXCLUDED.display_name,
    deposit_address = EXCLUDED.deposit_address,
    destination_tag = EXCLUDED.destination_tag,
    minimum_amount_usd = EXCLUDED.minimum_amount_usd,
    maximum_amount_usd = EXCLUDED.maximum_amount_usd,
    required_confirmations = EXCLUDED.required_confirmations,
    display_order = EXCLUDED.display_order,
    is_enabled = FALSE,
    is_primary = FALSE,
    settings =
        COALESCE(crypto_payment_methods.settings, '{}'::jsonb)
        || EXCLUDED.settings,
    updated_at = NOW();


-- ------------------------------------------------------------
-- SOL / Solana
-- ------------------------------------------------------------
INSERT INTO crypto_payment_methods (
    provider,
    asset,
    network,
    display_name,
    deposit_address,
    destination_tag,
    minimum_amount_usd,
    maximum_amount_usd,
    required_confirmations,
    display_order,
    is_enabled,
    is_primary,
    settings
)
VALUES (
    'binance_onchain',
    'SOL',
    'SOL',
    'Solana (SOL)',
    '9fPoRQE5dMmZ7EtrZqzFjq5i8MZ4VaVfXyGk3xtP1Aqp',
    NULL,
    5.00,
    500.00,
    1,
    50,
    FALSE,
    FALSE,
    '{"tx_hash_required": true, "quote_required": true}'::jsonb
)
ON CONFLICT (provider, asset, network)
DO UPDATE SET
    display_name = EXCLUDED.display_name,
    deposit_address = EXCLUDED.deposit_address,
    destination_tag = EXCLUDED.destination_tag,
    minimum_amount_usd = EXCLUDED.minimum_amount_usd,
    maximum_amount_usd = EXCLUDED.maximum_amount_usd,
    required_confirmations = EXCLUDED.required_confirmations,
    display_order = EXCLUDED.display_order,
    is_enabled = FALSE,
    is_primary = FALSE,
    settings =
        COALESCE(crypto_payment_methods.settings, '{}'::jsonb)
        || EXCLUDED.settings,
    updated_at = NOW();


-- ------------------------------------------------------------
-- ETH / Ethereum ERC20
-- ------------------------------------------------------------
INSERT INTO crypto_payment_methods (
    provider,
    asset,
    network,
    display_name,
    deposit_address,
    destination_tag,
    minimum_amount_usd,
    maximum_amount_usd,
    required_confirmations,
    display_order,
    is_enabled,
    is_primary,
    settings
)
VALUES (
    'binance_onchain',
    'ETH',
    'ERC20',
    'Ethereum (ERC20)',
    '0x3ce914ae82a29fb03c162d03d8b873a178b4bdaf',
    NULL,
    5.00,
    500.00,
    1,
    60,
    FALSE,
    FALSE,
    '{"tx_hash_required": true, "quote_required": true}'::jsonb
)
ON CONFLICT (provider, asset, network)
DO UPDATE SET
    display_name = EXCLUDED.display_name,
    deposit_address = EXCLUDED.deposit_address,
    destination_tag = EXCLUDED.destination_tag,
    minimum_amount_usd = EXCLUDED.minimum_amount_usd,
    maximum_amount_usd = EXCLUDED.maximum_amount_usd,
    required_confirmations = EXCLUDED.required_confirmations,
    display_order = EXCLUDED.display_order,
    is_enabled = FALSE,
    is_primary = FALSE,
    settings =
        COALESCE(crypto_payment_methods.settings, '{}'::jsonb)
        || EXCLUDED.settings,
    updated_at = NOW();

COMMIT;