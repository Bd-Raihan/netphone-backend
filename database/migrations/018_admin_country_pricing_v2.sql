BEGIN;

-- =========================================================
-- NetPhone Admin Country Pricing V2
--
-- উদ্দেশ্য:
-- 1. Country-level pricing policy provider থেকে আলাদা রাখা
-- 2. Provider বদলালেও markup/manual sell rate অক্ষত রাখা
-- 3. সব imported provider country Dashboard-এ দেখানো
-- 4. Decimal-safe pricing রাখা
-- =========================================================

SELECT pg_advisory_xact_lock(
  hashtext(
    'netphone:018_admin_country_pricing_v2'
  )
);

-- ---------------------------------------------------------
-- 1. Country-level retail pricing policy
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS
  voice_country_pricing_policies
(
  id BIGSERIAL PRIMARY KEY,

  country_code VARCHAR(8) NOT NULL,
  country_name VARCHAR(120) NOT NULL,

  -- UI/API representative prefix।
  -- এটি country identification-এর জন্য;
  -- actual call matching provider rate দিয়েই হবে।
  representative_prefix VARCHAR(20),

  pricing_mode VARCHAR(30)
    NOT NULL
    DEFAULT 'auto_markup',

  markup_percent NUMERIC(9,4)
    NOT NULL
    DEFAULT 25.0000,

  manual_sell_rate_usd_per_min
    NUMERIC(14,7),

  min_profit_usd_per_min
    NUMERIC(14,7)
    NOT NULL
    DEFAULT 0.0020000,

  is_enabled BOOLEAN
    NOT NULL
    DEFAULT TRUE,

  publish_rate BOOLEAN
    NOT NULL
    DEFAULT TRUE,

  pricing_note TEXT,

  updated_by BIGINT
    REFERENCES users(id)
    ON DELETE SET NULL,

  created_at TIMESTAMPTZ
    NOT NULL
    DEFAULT NOW(),

  updated_at TIMESTAMPTZ
    NOT NULL
    DEFAULT NOW(),

  CONSTRAINT
    uq_voice_country_pricing_country
    UNIQUE (country_code),

  CONSTRAINT
    chk_voice_country_pricing_code
    CHECK (
      country_code =
      UPPER(country_code)
    ),

  CONSTRAINT
    chk_voice_country_pricing_prefix
    CHECK (
      representative_prefix IS NULL
      OR representative_prefix
         ~ '^[0-9]{1,20}$'
    ),

  CONSTRAINT
    chk_voice_country_pricing_mode
    CHECK (
      pricing_mode IN (
        'auto_markup',
        'manual_rate'
      )
    ),

  CONSTRAINT
    chk_voice_country_pricing_markup
    CHECK (
      markup_percent >= 0
      AND markup_percent <= 1000
    ),

  CONSTRAINT
    chk_voice_country_pricing_manual_rate
    CHECK (
      manual_sell_rate_usd_per_min
        IS NULL
      OR
      manual_sell_rate_usd_per_min > 0
    ),

  CONSTRAINT
    chk_voice_country_pricing_profit
    CHECK (
      min_profit_usd_per_min >= 0
    ),

  CONSTRAINT
    chk_voice_country_manual_mode_rate
    CHECK (
      pricing_mode <> 'manual_rate'
      OR
      manual_sell_rate_usd_per_min
        IS NOT NULL
    )
);

-- ---------------------------------------------------------
-- 2. updated_at trigger
-- ---------------------------------------------------------
DROP TRIGGER IF EXISTS
  trg_voice_country_pricing_updated_at
ON voice_country_pricing_policies;

CREATE TRIGGER
  trg_voice_country_pricing_updated_at

BEFORE UPDATE
ON voice_country_pricing_policies

FOR EACH ROW
EXECUTE FUNCTION netphone_set_updated_at();

-- ---------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------
CREATE INDEX IF NOT EXISTS
  idx_voice_country_pricing_enabled

ON voice_country_pricing_policies (
  is_enabled,
  publish_rate,
  country_code
);

CREATE INDEX IF NOT EXISTS
  idx_voice_country_pricing_prefix

ON voice_country_pricing_policies (
  representative_prefix
);

-- Provider rates-এর country Dashboard query দ্রুত করবে।
CREATE INDEX IF NOT EXISTS
  idx_voice_provider_rates_country_active_card

ON voice_provider_rates (
  country_code,
  provider_id,
  rate_card_id,
  is_active
);

-- ---------------------------------------------------------
-- 4. সব active imported country seed
-- ---------------------------------------------------------
-- ---------------------------------------------------------
-- 4. সব active imported country seed
-- ---------------------------------------------------------
WITH active_country_rates AS (
  SELECT
    UPPER(
      TRIM(vpr.country_code)
    ) AS country_code,

    /*
     * Provider-এর সরাসরি country_name আগে নেওয়া হবে।
     * সেটি না থাকলে destination_name fallback হবে।
     */
    COALESCE(
      NULLIF(
        TRIM(vpr.country_name),
        ''
      ),

      NULLIF(
        TRIM(vpr.destination_name),
        ''
      ),

      UPPER(
        TRIM(vpr.country_code)
      )
    ) AS country_name,

    CASE
      WHEN NULLIF(
        TRIM(vpr.country_name),
        ''
      ) IS NOT NULL
        THEN 0
      ELSE 1
    END AS country_name_priority,

    vpr.prefix

  FROM voice_provider_rates vpr

  JOIN voice_provider_rate_cards vprc
    ON vprc.id =
       vpr.rate_card_id

  JOIN voice_providers vp
    ON vp.id =
       vpr.provider_id

  WHERE vpr.is_active = TRUE
    AND vprc.is_active = TRUE

    AND vp.status = 'active'
    AND vp.supports_voice = TRUE

    AND (
      vpr.effective_from IS NULL
      OR vpr.effective_from <= NOW()
    )

    AND (
      vpr.effective_until IS NULL
      OR vpr.effective_until > NOW()
    )

    AND (
      vprc.effective_from IS NULL
      OR vprc.effective_from <= NOW()
    )

    AND (
      vprc.effective_until IS NULL
      OR vprc.effective_until > NOW()
    )

    AND NULLIF(
      TRIM(vpr.country_code),
      ''
    ) IS NOT NULL

    AND NULLIF(
      TRIM(vpr.prefix),
      ''
    ) IS NOT NULL
),

imported_countries AS (
  SELECT
    country_code,

    /*
     * একই country_code-এর জন্য মাত্র একটি
     * professional country name নির্বাচন করবে।
     *
     * Priority:
     * 1. Provider country_name
     * 2. Destination fallback name
     * 3. ছোট এবং deterministic name
     */
    (
      ARRAY_AGG(
        country_name

        ORDER BY
          country_name_priority ASC,
          LENGTH(country_name) ASC,
          country_name ASC
      )
    )[1] AS country_name,

    /*
     * Dashboard/API lookup-এর জন্য country-এর
     * সবচেয়ে ছোট representative prefix।
     */
    (
      ARRAY_AGG(
        prefix

        ORDER BY
          LENGTH(prefix) ASC,
          prefix ASC
      )
    )[1] AS representative_prefix

  FROM active_country_rates

  GROUP BY
    country_code
)

INSERT INTO
  voice_country_pricing_policies
(
  country_code,
  country_name,
  representative_prefix,

  pricing_mode,
  markup_percent,
  manual_sell_rate_usd_per_min,

  min_profit_usd_per_min,

  is_enabled,
  publish_rate,

  pricing_note
)

SELECT
  country_code,
  country_name,
  representative_prefix,

  'auto_markup',
  25.0000,
  NULL,

  0.0020000,

  TRUE,
  TRUE,

  'Seeded from active provider rates'

FROM imported_countries

ON CONFLICT (country_code)
DO UPDATE SET
  country_name =
    EXCLUDED.country_name,

  representative_prefix =
    COALESCE(
      voice_country_pricing_policies
        .representative_prefix,

      EXCLUDED
        .representative_prefix
    ),

  updated_at = NOW();

-- ---------------------------------------------------------
-- 5. Existing country-level configurations migrate
-- ---------------------------------------------------------
INSERT INTO
  voice_country_pricing_policies
(
  country_code,
  country_name,
  representative_prefix,

  pricing_mode,
  markup_percent,
  manual_sell_rate_usd_per_min,

  min_profit_usd_per_min,

  is_enabled,
  publish_rate,

  pricing_note,
  updated_by,
  updated_at
)

SELECT DISTINCT ON (
  UPPER(cr.country_code)
)
  UPPER(cr.country_code),

  COALESCE(
    NULLIF(cr.country_name, ''),
    UPPER(cr.country_code)
  ),

  cr.prefix,

  CASE
    WHEN COALESCE(
      cr.manual_override,
      FALSE
    ) = TRUE
      THEN 'manual_rate'
    ELSE 'auto_markup'
  END,

  COALESCE(
    cr.markup_percent,
    25.0000
  ),

  CASE
    WHEN COALESCE(
      cr.manual_override,
      FALSE
    ) = TRUE
      THEN cr.sell_rate_usd_per_min
    ELSE NULL
  END,

  COALESCE(
    cr.min_profit_usd_per_min,
    0.0020000
  ),

  COALESCE(
    cr.is_active,
    TRUE
  ),

  COALESCE(
    cr.publish_rate,
    TRUE
  ),

  cr.manual_rate_note,
  cr.manual_rate_updated_by,

  COALESCE(
    cr.manual_rate_updated_at,
    cr.updated_at,
    NOW()
  )

FROM call_rates cr

WHERE NULLIF(
  TRIM(cr.country_code),
  ''
) IS NOT NULL

ORDER BY
  UPPER(cr.country_code),
  COALESCE(
    cr.manual_override,
    FALSE
  ) DESC,
  cr.updated_at DESC NULLS LAST,
  cr.id DESC

ON CONFLICT (country_code)
DO UPDATE SET
  pricing_mode =
    EXCLUDED.pricing_mode,

  markup_percent =
    EXCLUDED.markup_percent,

  manual_sell_rate_usd_per_min =
    EXCLUDED
      .manual_sell_rate_usd_per_min,

  min_profit_usd_per_min =
    EXCLUDED.min_profit_usd_per_min,

  is_enabled =
    EXCLUDED.is_enabled,

  publish_rate =
    EXCLUDED.publish_rate,

  pricing_note =
    COALESCE(
      EXCLUDED.pricing_note,

      voice_country_pricing_policies
        .pricing_note
    ),

  updated_by =
    COALESCE(
      EXCLUDED.updated_by,

      voice_country_pricing_policies
        .updated_by
    ),

  updated_at = NOW();

-- ---------------------------------------------------------
-- 6. Documentation
-- ---------------------------------------------------------
COMMENT ON TABLE
  voice_country_pricing_policies
IS
  'Provider-agnostic country retail pricing policies used by the multi-provider router.';

COMMENT ON COLUMN
  voice_country_pricing_policies
    .pricing_mode
IS
  'auto_markup recalculates from the selected provider cost; manual_rate uses a fixed country sell rate.';

COMMENT ON COLUMN
  voice_country_pricing_policies
    .representative_prefix
IS
  'Display/API lookup prefix only. Actual calls resolve country through the selected provider rate.';

-- ---------------------------------------------------------
-- 7. Legacy prefix manual overrides disable
-- ---------------------------------------------------------
-- Existing configuration V2 country policy table-এ migrate
-- হওয়ার পর পুরোনো override যেন নতুন policy bypass না করে।
UPDATE call_rates
SET
  manual_override = FALSE,

  pricing_mode =
    'auto_markup',

  rate_source =
    'country_pricing_v2_migrated',

  updated_at = NOW()

WHERE COALESCE(
  manual_override,
  FALSE
) = TRUE;

COMMIT;