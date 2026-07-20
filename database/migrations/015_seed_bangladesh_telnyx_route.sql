-- =========================================================
-- 015_seed_bangladesh_telnyx_route.sql
--
-- Purpose:
--   Create or repair the Bangladesh outbound voice route for
--   prefix 880 and map it to the active Telnyx PAYG rate card.
--
-- Depends on:
--   013_multi_provider_core.sql
--   Successful Telnyx PAYG provider-rate import
--
-- Safe to run multiple times:
--   Yes. Uses UPSERT logic and advisory transaction lock.
-- =========================================================

BEGIN;

SELECT pg_advisory_xact_lock(
    hashtext('015_seed_bangladesh_telnyx_route')
);

-- ---------------------------------------------------------
-- Safety checks
-- Do not create an incomplete route when provider, plan,
-- or active imported rate card is missing.
-- ---------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM voice_providers
        WHERE code = 'telnyx'
          AND status = 'active'
          AND supports_voice = TRUE
    ) THEN
        RAISE EXCEPTION
            'Active Telnyx voice provider was not found';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM voice_provider_plans vpp
        JOIN voice_providers vp
          ON vp.id = vpp.provider_id
        WHERE vp.code = 'telnyx'
          AND vpp.code = 'payg'
          AND vpp.is_active = TRUE
    ) THEN
        RAISE EXCEPTION
            'Active Telnyx PAYG provider plan was not found';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM voice_provider_rate_cards vprc
        JOIN voice_providers vp
          ON vp.id = vprc.provider_id
        JOIN voice_provider_plans vpp
          ON vpp.id = vprc.provider_plan_id
        WHERE vp.code = 'telnyx'
          AND vpp.code = 'payg'
          AND vprc.is_active = TRUE
          AND (
              vprc.effective_from IS NULL
              OR vprc.effective_from <= NOW()
          )
          AND (
              vprc.effective_until IS NULL
              OR vprc.effective_until > NOW()
          )
    ) THEN
        RAISE EXCEPTION
            'Active Telnyx PAYG rate card was not found';
    END IF;
END
$$;

-- ---------------------------------------------------------
-- Ensure Bangladesh destination policy is enabled.
-- This affects only Bangladesh / prefix 880.
-- ---------------------------------------------------------
UPDATE voice_destination_policies
SET
    is_enabled = TRUE,
    publish_rates = TRUE,
    disabled_reason = NULL,
    updated_at = NOW()
WHERE country_code = 'BD'
   OR prefix = '880';

-- ---------------------------------------------------------
-- Create or repair Bangladesh route.
-- ---------------------------------------------------------
INSERT INTO voice_routes (
    code,
    name,
    country_code,
    prefix,
    is_active,
    strategy,
    markup_percent,
    min_profit_usd_per_min,
    metadata
)
VALUES (
    'bd-880-telnyx',
    'Bangladesh via Telnyx',
    'BD',
    '880',
    TRUE,
    'priority_fallback',
    25.0000,
    0.0020000,
    jsonb_build_object(
        'migration', '015_seed_bangladesh_telnyx_route',
        'managed_by', 'database_migration'
    )
)
ON CONFLICT (code)
DO UPDATE SET
    name = EXCLUDED.name,
    country_code = EXCLUDED.country_code,
    prefix = EXCLUDED.prefix,
    is_active = TRUE,
    strategy = EXCLUDED.strategy,
    markup_percent = EXCLUDED.markup_percent,
    min_profit_usd_per_min = EXCLUDED.min_profit_usd_per_min,
    metadata = voice_routes.metadata || EXCLUDED.metadata,
    updated_at = NOW();

-- ---------------------------------------------------------
-- Map route to Telnyx PAYG and newest currently-active card.
-- ---------------------------------------------------------
WITH selected_mapping AS (
    SELECT
        vr.id AS route_id,
        vp.id AS provider_id,
        vpp.id AS provider_plan_id,
        vprc.id AS rate_card_id
    FROM voice_routes vr
    JOIN voice_providers vp
      ON vp.code = 'telnyx'
     AND vp.status = 'active'
     AND vp.supports_voice = TRUE
    JOIN voice_provider_plans vpp
      ON vpp.provider_id = vp.id
     AND vpp.code = 'payg'
     AND vpp.is_active = TRUE
    JOIN LATERAL (
        SELECT rc.id
        FROM voice_provider_rate_cards rc
        WHERE rc.provider_id = vp.id
          AND rc.provider_plan_id = vpp.id
          AND rc.is_active = TRUE
          AND (
              rc.effective_from IS NULL
              OR rc.effective_from <= NOW()
          )
          AND (
              rc.effective_until IS NULL
              OR rc.effective_until > NOW()
          )
        ORDER BY
            rc.effective_from DESC NULLS LAST,
            rc.id DESC
        LIMIT 1
    ) vprc ON TRUE
    WHERE vr.code = 'bd-880-telnyx'
)
INSERT INTO voice_route_providers (
    route_id,
    provider_id,
    provider_plan_id,
    rate_card_id,
    priority,
    weight,
    is_active,
    allow_fallback,
    metadata
)
SELECT
    route_id,
    provider_id,
    provider_plan_id,
    rate_card_id,
    1,
    100,
    TRUE,
    FALSE,
    jsonb_build_object(
        'migration', '015_seed_bangladesh_telnyx_route',
        'managed_by', 'database_migration'
    )
FROM selected_mapping
ON CONFLICT (route_id, provider_id)
DO UPDATE SET
    provider_plan_id = EXCLUDED.provider_plan_id,
    rate_card_id = EXCLUDED.rate_card_id,
    priority = 1,
    weight = 100,
    is_active = TRUE,
    allow_fallback = FALSE,
    metadata = voice_route_providers.metadata || EXCLUDED.metadata,
    updated_at = NOW();

-- ---------------------------------------------------------
-- Verification output
-- ---------------------------------------------------------
SELECT
    vr.id AS route_id,
    vr.code AS route_code,
    vr.country_code,
    vr.prefix,
    vr.is_active AS route_active,
    vp.code AS provider_code,
    vpp.code AS plan_code,
    vprc.code AS rate_card_code,
    vrp.priority,
    vrp.is_active AS mapping_active
FROM voice_route_providers vrp
JOIN voice_routes vr
  ON vr.id = vrp.route_id
JOIN voice_providers vp
  ON vp.id = vrp.provider_id
LEFT JOIN voice_provider_plans vpp
  ON vpp.id = vrp.provider_plan_id
LEFT JOIN voice_provider_rate_cards vprc
  ON vprc.id = vrp.rate_card_id
WHERE vr.code = 'bd-880-telnyx';

COMMIT;