-- =============================================================
-- 013_multi_provider_core.sql
-- NetPhone Multi-Provider Voice Router Core
-- PostgreSQL production migration
--
-- Adds:
--   * Voice provider registry
--   * Provider commercial plans and discounts
--   * Provider-specific rate cards and prefix rates
--   * Country/prefix routing with priority and fallback
--   * Destination disable controls and maximum-cost protection
--   * 25% default markup and minimum-profit protection
--   * Immutable billing/routing snapshots on call_sessions
--
-- Safe to run more than once.
-- =============================================================

BEGIN;

-- Prevent two deployment processes from applying this migration concurrently.
SELECT pg_advisory_xact_lock(hashtext('netphone:013_multi_provider_core'));

-- -------------------------------------------------------------
-- Shared updated_at trigger
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION netphone_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

-- -------------------------------------------------------------
-- 1. Voice provider registry
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice_providers (
  id                         BIGSERIAL PRIMARY KEY,
  code                       VARCHAR(50) NOT NULL,
  name                       VARCHAR(120) NOT NULL,
  provider_type              VARCHAR(30) NOT NULL DEFAULT 'api',
  status                     VARCHAR(20) NOT NULL DEFAULT 'active',
  supports_voice             BOOLEAN NOT NULL DEFAULT TRUE,
  supports_rate_import       BOOLEAN NOT NULL DEFAULT TRUE,
  supports_webhooks          BOOLEAN NOT NULL DEFAULT TRUE,
  api_base_url               TEXT,
  webhook_path               TEXT,
  default_currency           CHAR(3) NOT NULL DEFAULT 'USD',
  default_platform_fee_usd   NUMERIC(12,6) NOT NULL DEFAULT 0.000000,
  metadata                   JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_voice_providers_code UNIQUE (code),
  CONSTRAINT chk_voice_providers_code
    CHECK (code = LOWER(code) AND code ~ '^[a-z0-9][a-z0-9_-]{1,49}$'),
  CONSTRAINT chk_voice_providers_type
    CHECK (provider_type IN ('api', 'sip', 'wholesale', 'hybrid')),
  CONSTRAINT chk_voice_providers_status
    CHECK (status IN ('active', 'maintenance', 'disabled')),
  CONSTRAINT chk_voice_providers_currency
    CHECK (default_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_voice_providers_platform_fee
    CHECK (default_platform_fee_usd >= 0)
);

DROP TRIGGER IF EXISTS trg_voice_providers_updated_at ON voice_providers;
CREATE TRIGGER trg_voice_providers_updated_at
BEFORE UPDATE ON voice_providers
FOR EACH ROW EXECUTE FUNCTION netphone_set_updated_at();

CREATE INDEX IF NOT EXISTS idx_voice_providers_active
  ON voice_providers(status)
  WHERE status = 'active' AND supports_voice = TRUE;

-- Keep the current Telnyx integration active.
INSERT INTO voice_providers (
  code,
  name,
  provider_type,
  status,
  supports_voice,
  supports_rate_import,
  supports_webhooks,
  webhook_path,
  default_currency
)
VALUES (
  'telnyx',
  'Telnyx',
  'api',
  'active',
  TRUE,
  TRUE,
  TRUE,
  '/api/calls/telnyx-events',
  'USD'
)
ON CONFLICT (code) DO UPDATE
SET
  name = EXCLUDED.name,
  status = 'active',
  supports_voice = TRUE,
  supports_rate_import = TRUE,
  supports_webhooks = TRUE,
  webhook_path = EXCLUDED.webhook_path,
  updated_at = NOW();

-- -------------------------------------------------------------
-- 2. Provider plans / contracted discounts
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice_provider_plans (
  id                         BIGSERIAL PRIMARY KEY,
  provider_id                BIGINT NOT NULL REFERENCES voice_providers(id) ON DELETE CASCADE,
  code                       VARCHAR(50) NOT NULL,
  name                       VARCHAR(120) NOT NULL,
  plan_tier                  VARCHAR(30) NOT NULL DEFAULT 'pay_as_you_go',
  discount_percent           NUMERIC(7,4) NOT NULL DEFAULT 0.0000,
  platform_fee_usd_per_min   NUMERIC(12,6) NOT NULL DEFAULT 0.000000,
  monthly_fee_usd            NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  minimum_commit_usd         NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  valid_from                 TIMESTAMPTZ,
  valid_until                TIMESTAMPTZ,
  is_active                  BOOLEAN NOT NULL DEFAULT TRUE,
  is_default                 BOOLEAN NOT NULL DEFAULT FALSE,
  metadata                   JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_voice_provider_plans_code UNIQUE (provider_id, code),
  CONSTRAINT chk_voice_provider_plans_code
    CHECK (code = LOWER(code) AND code ~ '^[a-z0-9][a-z0-9_-]{1,49}$'),
  CONSTRAINT chk_voice_provider_plans_tier
    CHECK (plan_tier IN ('pay_as_you_go', 'starter', 'growth', 'enterprise', 'custom')),
  CONSTRAINT chk_voice_provider_plans_discount
    CHECK (discount_percent >= 0 AND discount_percent <= 100),
  CONSTRAINT chk_voice_provider_plans_platform_fee
    CHECK (platform_fee_usd_per_min >= 0),
  CONSTRAINT chk_voice_provider_plans_monthly_fee
    CHECK (monthly_fee_usd >= 0),
  CONSTRAINT chk_voice_provider_plans_commit
    CHECK (minimum_commit_usd >= 0),
  CONSTRAINT chk_voice_provider_plans_validity
    CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from)
);

DROP TRIGGER IF EXISTS trg_voice_provider_plans_updated_at ON voice_provider_plans;
CREATE TRIGGER trg_voice_provider_plans_updated_at
BEFORE UPDATE ON voice_provider_plans
FOR EACH ROW EXECUTE FUNCTION netphone_set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_provider_default_plan
  ON voice_provider_plans(provider_id)
  WHERE is_default = TRUE AND is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_voice_provider_plans_active
  ON voice_provider_plans(provider_id, is_active, valid_from, valid_until);

INSERT INTO voice_provider_plans (
  provider_id,
  code,
  name,
  plan_tier,
  discount_percent,
  platform_fee_usd_per_min,
  is_active,
  is_default
)
SELECT
  vp.id,
  'payg',
  'Pay As You Go',
  'pay_as_you_go',
  0.0000,
  0.000000,
  TRUE,
  TRUE
FROM voice_providers vp
WHERE vp.code = 'telnyx'
ON CONFLICT (provider_id, code) DO UPDATE
SET
  name = EXCLUDED.name,
  plan_tier = EXCLUDED.plan_tier,
  is_active = TRUE,
  is_default = TRUE,
  updated_at = NOW();

-- -------------------------------------------------------------
-- 3. Provider-specific imported rate cards
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice_provider_rate_cards (
  id                         BIGSERIAL PRIMARY KEY,
  provider_id                BIGINT NOT NULL REFERENCES voice_providers(id) ON DELETE CASCADE,
  provider_plan_id           BIGINT REFERENCES voice_provider_plans(id) ON DELETE SET NULL,
  code                       VARCHAR(100) NOT NULL,
  name                       VARCHAR(160) NOT NULL,
  currency                   CHAR(3) NOT NULL DEFAULT 'USD',
  billing_increment_seconds  INTEGER NOT NULL DEFAULT 60,
  minimum_duration_seconds   INTEGER NOT NULL DEFAULT 60,
  effective_from             TIMESTAMPTZ,
  effective_until            TIMESTAMPTZ,
  source_type                VARCHAR(30) NOT NULL DEFAULT 'csv',
  source_reference           TEXT,
  source_checksum            VARCHAR(128),
  imported_at                TIMESTAMPTZ,
  is_active                  BOOLEAN NOT NULL DEFAULT FALSE,
  metadata                   JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_voice_provider_rate_cards_code UNIQUE (provider_id, code),
  CONSTRAINT chk_voice_provider_rate_cards_currency
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_voice_provider_rate_cards_increment
    CHECK (billing_increment_seconds > 0 AND billing_increment_seconds <= 3600),
  CONSTRAINT chk_voice_provider_rate_cards_minimum
    CHECK (minimum_duration_seconds >= 0 AND minimum_duration_seconds <= 86400),
  CONSTRAINT chk_voice_provider_rate_cards_source
    CHECK (source_type IN ('csv', 'api', 'manual', 'contract')),
  CONSTRAINT chk_voice_provider_rate_cards_validity
    CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until > effective_from)
);

DROP TRIGGER IF EXISTS trg_voice_provider_rate_cards_updated_at ON voice_provider_rate_cards;
CREATE TRIGGER trg_voice_provider_rate_cards_updated_at
BEFORE UPDATE ON voice_provider_rate_cards
FOR EACH ROW EXECUTE FUNCTION netphone_set_updated_at();

CREATE INDEX IF NOT EXISTS idx_voice_provider_rate_cards_active
  ON voice_provider_rate_cards(provider_id, is_active, effective_from, effective_until);

-- -------------------------------------------------------------
-- 4. Provider termination rates by E.164 prefix
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice_provider_rates (
  id                         BIGSERIAL PRIMARY KEY,
  rate_card_id               BIGINT NOT NULL REFERENCES voice_provider_rate_cards(id) ON DELETE CASCADE,
  provider_id                BIGINT NOT NULL REFERENCES voice_providers(id) ON DELETE CASCADE,
  country_code               VARCHAR(8),
  country_name               VARCHAR(120),
  destination_name           VARCHAR(180),
  prefix                     VARCHAR(20) NOT NULL,
  raw_rate_usd_per_min       NUMERIC(14,7) NOT NULL,
  connection_fee_usd         NUMERIC(14,7) NOT NULL DEFAULT 0.0000000,
  billing_increment_seconds  INTEGER,
  minimum_duration_seconds   INTEGER,
  effective_from             TIMESTAMPTZ,
  effective_until            TIMESTAMPTZ,
  is_active                  BOOLEAN NOT NULL DEFAULT TRUE,
  metadata                   JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_voice_provider_rates_prefix UNIQUE (rate_card_id, prefix),
  CONSTRAINT chk_voice_provider_rates_prefix
    CHECK (prefix ~ '^[0-9]{1,20}$'),
  CONSTRAINT chk_voice_provider_rates_raw_rate
    CHECK (raw_rate_usd_per_min > 0),
  CONSTRAINT chk_voice_provider_rates_connection_fee
    CHECK (connection_fee_usd >= 0),
  CONSTRAINT chk_voice_provider_rates_increment
    CHECK (billing_increment_seconds IS NULL OR billing_increment_seconds > 0),
  CONSTRAINT chk_voice_provider_rates_minimum
    CHECK (minimum_duration_seconds IS NULL OR minimum_duration_seconds >= 0),
  CONSTRAINT chk_voice_provider_rates_validity
    CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until > effective_from)
);

DROP TRIGGER IF EXISTS trg_voice_provider_rates_updated_at ON voice_provider_rates;
CREATE TRIGGER trg_voice_provider_rates_updated_at
BEFORE UPDATE ON voice_provider_rates
FOR EACH ROW EXECUTE FUNCTION netphone_set_updated_at();

CREATE INDEX IF NOT EXISTS idx_voice_provider_rates_lookup
  ON voice_provider_rates(provider_id, prefix, is_active);

CREATE INDEX IF NOT EXISTS idx_voice_provider_rates_longest_prefix
  ON voice_provider_rates(provider_id, (LENGTH(prefix)) DESC, prefix)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_voice_provider_rates_country
  ON voice_provider_rates(country_code, provider_id)
  WHERE is_active = TRUE;

-- Protect imported data from accidentally linking a rate card to another provider.
CREATE OR REPLACE FUNCTION netphone_validate_provider_rate_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_rate_card_provider_id BIGINT;
BEGIN
  SELECT provider_id
    INTO v_rate_card_provider_id
  FROM voice_provider_rate_cards
  WHERE id = NEW.rate_card_id;

  IF v_rate_card_provider_id IS NULL THEN
    RAISE EXCEPTION 'Rate card % does not exist', NEW.rate_card_id;
  END IF;

  IF v_rate_card_provider_id <> NEW.provider_id THEN
    RAISE EXCEPTION
      'Provider rate ownership mismatch: rate_card_id % belongs to provider %, not %',
      NEW.rate_card_id,
      v_rate_card_provider_id,
      NEW.provider_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_voice_provider_rates_validate_owner ON voice_provider_rates;
CREATE TRIGGER trg_voice_provider_rates_validate_owner
BEFORE INSERT OR UPDATE OF rate_card_id, provider_id ON voice_provider_rates
FOR EACH ROW EXECUTE FUNCTION netphone_validate_provider_rate_ownership();

-- -------------------------------------------------------------
-- 5. Destination policy / commercial safety rules
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice_destination_policies (
  id                         BIGSERIAL PRIMARY KEY,
  country_code               VARCHAR(8),
  prefix                     VARCHAR(20) NOT NULL,
  destination_name           VARCHAR(180),
  is_enabled                 BOOLEAN NOT NULL DEFAULT TRUE,
  publish_rates              BOOLEAN NOT NULL DEFAULT TRUE,
  max_provider_rate_usd_min  NUMERIC(14,7),
  markup_percent             NUMERIC(7,4) NOT NULL DEFAULT 25.0000,
  min_profit_usd_per_min     NUMERIC(14,7) NOT NULL DEFAULT 0.0020000,
  pricing_tier               VARCHAR(30) NOT NULL DEFAULT 'standard',
  disabled_reason            TEXT,
  valid_from                 TIMESTAMPTZ,
  valid_until                TIMESTAMPTZ,
  metadata                   JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_voice_destination_policies_prefix UNIQUE (prefix),
  CONSTRAINT chk_voice_destination_policies_prefix
    CHECK (prefix ~ '^[0-9]{1,20}$'),
  CONSTRAINT chk_voice_destination_policies_max_rate
    CHECK (max_provider_rate_usd_min IS NULL OR max_provider_rate_usd_min > 0),
  CONSTRAINT chk_voice_destination_policies_markup
    CHECK (markup_percent >= 0 AND markup_percent <= 1000),
  CONSTRAINT chk_voice_destination_policies_profit
    CHECK (min_profit_usd_per_min >= 0),
  CONSTRAINT chk_voice_destination_policies_tier
    CHECK (pricing_tier IN ('low_cost', 'standard', 'high_cost', 'custom')),
  CONSTRAINT chk_voice_destination_policies_validity
    CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from),
  CONSTRAINT chk_voice_destination_disabled_reason
    CHECK (is_enabled = TRUE OR disabled_reason IS NOT NULL)
);

DROP TRIGGER IF EXISTS trg_voice_destination_policies_updated_at ON voice_destination_policies;
CREATE TRIGGER trg_voice_destination_policies_updated_at
BEFORE UPDATE ON voice_destination_policies
FOR EACH ROW EXECUTE FUNCTION netphone_set_updated_at();

CREATE INDEX IF NOT EXISTS idx_voice_destination_policy_lookup
  ON voice_destination_policies((LENGTH(prefix)) DESC, prefix, is_enabled);

-- Bangladesh remains disabled and unpublished until a wholesale carrier is selected.
INSERT INTO voice_destination_policies (
  country_code,
  prefix,
  destination_name,
  is_enabled,
  publish_rates,
  markup_percent,
  min_profit_usd_per_min,
  pricing_tier,
  disabled_reason,
  metadata
)
VALUES (
  'BD',
  '880',
  'Bangladesh',
  FALSE,
  FALSE,
  25.0000,
  0.0020000,
  'custom',
  'Wholesale carrier not selected',
  '{"migration":"013_multi_provider_core"}'::JSONB
)
ON CONFLICT (prefix) DO UPDATE
SET
  country_code = 'BD',
  destination_name = 'Bangladesh',
  is_enabled = FALSE,
  publish_rates = FALSE,
  disabled_reason = 'Wholesale carrier not selected',
  updated_at = NOW();

-- -------------------------------------------------------------
-- 6. Logical routes by country/prefix
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice_routes (
  id                         BIGSERIAL PRIMARY KEY,
  code                       VARCHAR(100) NOT NULL,
  name                       VARCHAR(160) NOT NULL,
  country_code               VARCHAR(8),
  prefix                     VARCHAR(20) NOT NULL,
  is_active                  BOOLEAN NOT NULL DEFAULT TRUE,
  strategy                   VARCHAR(30) NOT NULL DEFAULT 'priority_fallback',
  max_provider_rate_usd_min  NUMERIC(14,7),
  markup_percent             NUMERIC(7,4),
  min_profit_usd_per_min     NUMERIC(14,7),
  valid_from                 TIMESTAMPTZ,
  valid_until                TIMESTAMPTZ,
  metadata                   JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_voice_routes_code UNIQUE (code),
  CONSTRAINT uq_voice_routes_prefix UNIQUE (prefix),
  CONSTRAINT chk_voice_routes_code
    CHECK (code = LOWER(code) AND code ~ '^[a-z0-9][a-z0-9_-]{1,99}$'),
  CONSTRAINT chk_voice_routes_prefix
    CHECK (prefix ~ '^[0-9]{1,20}$'),
  CONSTRAINT chk_voice_routes_strategy
    CHECK (strategy IN ('priority_fallback', 'least_cost', 'weighted')),
  CONSTRAINT chk_voice_routes_max_rate
    CHECK (max_provider_rate_usd_min IS NULL OR max_provider_rate_usd_min > 0),
  CONSTRAINT chk_voice_routes_markup
    CHECK (markup_percent IS NULL OR (markup_percent >= 0 AND markup_percent <= 1000)),
  CONSTRAINT chk_voice_routes_profit
    CHECK (min_profit_usd_per_min IS NULL OR min_profit_usd_per_min >= 0),
  CONSTRAINT chk_voice_routes_validity
    CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from)
);

DROP TRIGGER IF EXISTS trg_voice_routes_updated_at ON voice_routes;
CREATE TRIGGER trg_voice_routes_updated_at
BEFORE UPDATE ON voice_routes
FOR EACH ROW EXECUTE FUNCTION netphone_set_updated_at();

CREATE INDEX IF NOT EXISTS idx_voice_routes_lookup
  ON voice_routes((LENGTH(prefix)) DESC, prefix, is_active);

-- -------------------------------------------------------------
-- 7. Ordered provider candidates for each route
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice_route_providers (
  id                         BIGSERIAL PRIMARY KEY,
  route_id                   BIGINT NOT NULL REFERENCES voice_routes(id) ON DELETE CASCADE,
  provider_id                BIGINT NOT NULL REFERENCES voice_providers(id) ON DELETE RESTRICT,
  provider_plan_id           BIGINT REFERENCES voice_provider_plans(id) ON DELETE SET NULL,
  rate_card_id               BIGINT REFERENCES voice_provider_rate_cards(id) ON DELETE SET NULL,
  priority                   INTEGER NOT NULL DEFAULT 100,
  weight                     INTEGER NOT NULL DEFAULT 100,
  is_active                  BOOLEAN NOT NULL DEFAULT TRUE,
  allow_fallback             BOOLEAN NOT NULL DEFAULT TRUE,
  max_provider_rate_usd_min  NUMERIC(14,7),
  platform_fee_usd_per_min   NUMERIC(14,7),
  valid_from                 TIMESTAMPTZ,
  valid_until                TIMESTAMPTZ,
  metadata                   JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_voice_route_provider UNIQUE (route_id, provider_id),
  CONSTRAINT chk_voice_route_provider_priority CHECK (priority > 0),
  CONSTRAINT chk_voice_route_provider_weight CHECK (weight > 0),
  CONSTRAINT chk_voice_route_provider_max_rate
    CHECK (max_provider_rate_usd_min IS NULL OR max_provider_rate_usd_min > 0),
  CONSTRAINT chk_voice_route_provider_platform_fee
    CHECK (platform_fee_usd_per_min IS NULL OR platform_fee_usd_per_min >= 0),
  CONSTRAINT chk_voice_route_provider_validity
    CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from)
);

DROP TRIGGER IF EXISTS trg_voice_route_providers_updated_at ON voice_route_providers;
CREATE TRIGGER trg_voice_route_providers_updated_at
BEFORE UPDATE ON voice_route_providers
FOR EACH ROW EXECUTE FUNCTION netphone_set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_route_provider_priority
  ON voice_route_providers(route_id, priority)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_voice_route_providers_selection
  ON voice_route_providers(route_id, is_active, priority, provider_id);

-- Validate that plan/rate-card ownership matches the selected provider.
CREATE OR REPLACE FUNCTION netphone_validate_route_provider_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_plan_provider_id      BIGINT;
  v_rate_card_provider_id BIGINT;
BEGIN
  IF NEW.provider_plan_id IS NOT NULL THEN
    SELECT provider_id
      INTO v_plan_provider_id
    FROM voice_provider_plans
    WHERE id = NEW.provider_plan_id;

    IF v_plan_provider_id IS NULL OR v_plan_provider_id <> NEW.provider_id THEN
      RAISE EXCEPTION
        'Provider plan % does not belong to provider %',
        NEW.provider_plan_id,
        NEW.provider_id;
    END IF;
  END IF;

  IF NEW.rate_card_id IS NOT NULL THEN
    SELECT provider_id
      INTO v_rate_card_provider_id
    FROM voice_provider_rate_cards
    WHERE id = NEW.rate_card_id;

    IF v_rate_card_provider_id IS NULL OR v_rate_card_provider_id <> NEW.provider_id THEN
      RAISE EXCEPTION
        'Rate card % does not belong to provider %',
        NEW.rate_card_id,
        NEW.provider_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_voice_route_providers_validate_owner ON voice_route_providers;
CREATE TRIGGER trg_voice_route_providers_validate_owner
BEFORE INSERT OR UPDATE OF provider_id, provider_plan_id, rate_card_id
ON voice_route_providers
FOR EACH ROW EXECUTE FUNCTION netphone_validate_route_provider_ownership();

-- -------------------------------------------------------------
-- 8. Pricing helper
-- Formula:
--   discounted termination rate
--   + platform/API fee
--   + operating margin
--   + minimum-profit protection
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION netphone_calculate_voice_price(
  p_provider_rate_usd_per_min NUMERIC,
  p_discount_percent          NUMERIC DEFAULT 0,
  p_platform_fee_usd_per_min  NUMERIC DEFAULT 0,
  p_markup_percent            NUMERIC DEFAULT 25,
  p_min_profit_usd_per_min    NUMERIC DEFAULT 0.002
)
RETURNS TABLE (
  discounted_provider_rate_usd_per_min NUMERIC(14,7),
  total_cost_usd_per_min                NUMERIC(14,7),
  sell_rate_usd_per_min                 NUMERIC(14,7),
  profit_usd_per_min                    NUMERIC(14,7)
)
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  v_discounted_rate NUMERIC;
  v_total_cost      NUMERIC;
  v_sell_rate       NUMERIC;
BEGIN
  IF p_provider_rate_usd_per_min <= 0 THEN
    RAISE EXCEPTION 'Provider rate must be greater than zero';
  END IF;

  IF p_discount_percent < 0 OR p_discount_percent > 100 THEN
    RAISE EXCEPTION 'Discount percent must be between 0 and 100';
  END IF;

  IF p_platform_fee_usd_per_min < 0
     OR p_markup_percent < 0
     OR p_min_profit_usd_per_min < 0 THEN
    RAISE EXCEPTION 'Pricing inputs cannot be negative';
  END IF;

  v_discounted_rate := p_provider_rate_usd_per_min
                       * (1 - (p_discount_percent / 100.0));
  v_total_cost := v_discounted_rate + p_platform_fee_usd_per_min;

  v_sell_rate := GREATEST(
    v_total_cost * (1 + (p_markup_percent / 100.0)),
    v_total_cost + p_min_profit_usd_per_min
  );

  discounted_provider_rate_usd_per_min := ROUND(v_discounted_rate, 7);
  total_cost_usd_per_min := ROUND(v_total_cost, 7);
  sell_rate_usd_per_min := ROUND(v_sell_rate, 7);
  profit_usd_per_min := ROUND(v_sell_rate - v_total_cost, 7);

  RETURN NEXT;
END;
$$;

-- -------------------------------------------------------------
-- 9. Extend existing retail rate table without breaking V3
-- -------------------------------------------------------------
ALTER TABLE call_rates
  ADD COLUMN IF NOT EXISTS route_id BIGINT,
  ADD COLUMN IF NOT EXISTS provider_id BIGINT,
  ADD COLUMN IF NOT EXISTS provider_plan_id BIGINT,
  ADD COLUMN IF NOT EXISTS provider_rate_id BIGINT,
  ADD COLUMN IF NOT EXISTS platform_fee_usd_per_min NUMERIC(14,7) DEFAULT 0.0000000,
  ADD COLUMN IF NOT EXISTS discounted_provider_rate_usd_per_min NUMERIC(14,7),
  ADD COLUMN IF NOT EXISTS max_provider_rate_usd_per_min NUMERIC(14,7),
  ADD COLUMN IF NOT EXISTS publish_rate BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS disabled_reason TEXT;

-- Add foreign keys only when they do not already exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_call_rates_route_id'
      AND conrelid = 'call_rates'::regclass
  ) THEN
    ALTER TABLE call_rates
      ADD CONSTRAINT fk_call_rates_route_id
      FOREIGN KEY (route_id) REFERENCES voice_routes(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_call_rates_provider_id'
      AND conrelid = 'call_rates'::regclass
  ) THEN
    ALTER TABLE call_rates
      ADD CONSTRAINT fk_call_rates_provider_id
      FOREIGN KEY (provider_id) REFERENCES voice_providers(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_call_rates_provider_plan_id'
      AND conrelid = 'call_rates'::regclass
  ) THEN
    ALTER TABLE call_rates
      ADD CONSTRAINT fk_call_rates_provider_plan_id
      FOREIGN KEY (provider_plan_id) REFERENCES voice_provider_plans(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_call_rates_provider_rate_id'
      AND conrelid = 'call_rates'::regclass
  ) THEN
    ALTER TABLE call_rates
      ADD CONSTRAINT fk_call_rates_provider_rate_id
      FOREIGN KEY (provider_rate_id) REFERENCES voice_provider_rates(id) ON DELETE SET NULL;
  END IF;
END;
$$;

-- New records default to the approved 25% markup.
ALTER TABLE call_rates
  ALTER COLUMN markup_percent SET DEFAULT 25.00;

ALTER TABLE call_rates
  ALTER COLUMN min_profit_usd_per_min SET DEFAULT 0.00200;

-- Link existing text provider='telnyx' rows to the provider registry.
UPDATE call_rates cr
SET provider_id = vp.id
FROM voice_providers vp
WHERE vp.code = LOWER(COALESCE(cr.provider, ''))
  AND cr.provider_id IS NULL;

-- Convert previous automatic 45% Telnyx pricing to the approved 25% rule.
-- Manual overrides are deliberately preserved.
UPDATE call_rates
SET
  markup_percent = 25.00,
  discounted_provider_rate_usd_per_min = provider_rate_usd_per_min,
  platform_fee_usd_per_min = COALESCE(platform_fee_usd_per_min, 0.0000000),
  sell_rate_usd_per_min = ROUND(
    GREATEST(
      provider_rate_usd_per_min
        + COALESCE(platform_fee_usd_per_min, 0.0000000),
      0
    ) * 1.25,
    5
  ),
  updated_at = NOW()
WHERE LOWER(COALESCE(provider, '')) = 'telnyx'
  AND COALESCE(manual_override, FALSE) = FALSE
  AND provider_rate_usd_per_min IS NOT NULL
  AND provider_rate_usd_per_min > 0
  AND COALESCE(markup_percent, 45.00) = 45.00;

-- Enforce minimum-profit protection and synchronize legacy cents display.
UPDATE call_rates
SET
  sell_rate_usd_per_min = ROUND(
    GREATEST(
      sell_rate_usd_per_min,
      COALESCE(discounted_provider_rate_usd_per_min, provider_rate_usd_per_min)
        + COALESCE(platform_fee_usd_per_min, 0.0000000)
        + COALESCE(min_profit_usd_per_min, 0.00200)
    ),
    5
  ),
  price_per_min_cents = GREATEST(
    1,
    CEIL(
      GREATEST(
        sell_rate_usd_per_min,
        COALESCE(discounted_provider_rate_usd_per_min, provider_rate_usd_per_min)
          + COALESCE(platform_fee_usd_per_min, 0.0000000)
          + COALESCE(min_profit_usd_per_min, 0.00200)
      ) * 100
    )::INTEGER
  ),
  updated_at = NOW()
WHERE COALESCE(manual_override, FALSE) = FALSE
  AND provider_rate_usd_per_min IS NOT NULL
  AND provider_rate_usd_per_min > 0;

-- Bangladesh is not publishable/active until a wholesale carrier is selected.
UPDATE call_rates
SET
  is_active = FALSE,
  publish_rate = FALSE,
  disabled_reason = 'Wholesale carrier not selected',
  updated_at = NOW()
WHERE prefix LIKE '880%'
   OR UPPER(COALESCE(country_code, '')) IN ('BD', 'BGD');

CREATE INDEX IF NOT EXISTS idx_call_rates_route_provider_active
  ON call_rates(route_id, provider_id, is_active);

CREATE INDEX IF NOT EXISTS idx_call_rates_provider_rate_id
  ON call_rates(provider_rate_id)
  WHERE provider_rate_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_call_rates_publishable
  ON call_rates(prefix, publish_rate, is_active)
  WHERE publish_rate = TRUE AND is_active = TRUE;

-- -------------------------------------------------------------
-- 10. Immutable provider/routing snapshots on call sessions
-- -------------------------------------------------------------
ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS provider_id BIGINT,
  ADD COLUMN IF NOT EXISTS provider_plan_id BIGINT,
  ADD COLUMN IF NOT EXISTS provider_rate_id BIGINT,
  ADD COLUMN IF NOT EXISTS route_id BIGINT,
  ADD COLUMN IF NOT EXISTS route_provider_id BIGINT,
  ADD COLUMN IF NOT EXISTS provider_plan_code VARCHAR(50),
  ADD COLUMN IF NOT EXISTS provider_discount_percent NUMERIC(7,4),
  ADD COLUMN IF NOT EXISTS provider_platform_fee_usd_per_min NUMERIC(14,7),
  ADD COLUMN IF NOT EXISTS discounted_provider_rate_usd_per_min NUMERIC(14,7),
  ADD COLUMN IF NOT EXISTS total_provider_cost_usd_per_min NUMERIC(14,7),
  ADD COLUMN IF NOT EXISTS pricing_markup_percent NUMERIC(7,4),
  ADD COLUMN IF NOT EXISTS pricing_min_profit_usd_per_min NUMERIC(14,7),
  ADD COLUMN IF NOT EXISTS route_attempts JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS routing_failure_code VARCHAR(80),
  ADD COLUMN IF NOT EXISTS routing_failure_reason TEXT;


-- Add foreign keys only when they do not already exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_call_sessions_provider_id'
      AND conrelid = 'call_sessions'::regclass
  ) THEN
    ALTER TABLE call_sessions
      ADD CONSTRAINT fk_call_sessions_provider_id
      FOREIGN KEY (provider_id) REFERENCES voice_providers(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_call_sessions_provider_plan_id'
      AND conrelid = 'call_sessions'::regclass
  ) THEN
    ALTER TABLE call_sessions
      ADD CONSTRAINT fk_call_sessions_provider_plan_id
      FOREIGN KEY (provider_plan_id) REFERENCES voice_provider_plans(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_call_sessions_provider_rate_id'
      AND conrelid = 'call_sessions'::regclass
  ) THEN
    ALTER TABLE call_sessions
      ADD CONSTRAINT fk_call_sessions_provider_rate_id
      FOREIGN KEY (provider_rate_id) REFERENCES voice_provider_rates(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_call_sessions_route_id'
      AND conrelid = 'call_sessions'::regclass
  ) THEN
    ALTER TABLE call_sessions
      ADD CONSTRAINT fk_call_sessions_route_id
      FOREIGN KEY (route_id) REFERENCES voice_routes(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_call_sessions_route_provider_id'
      AND conrelid = 'call_sessions'::regclass
  ) THEN
    ALTER TABLE call_sessions
      ADD CONSTRAINT fk_call_sessions_route_provider_id
      FOREIGN KEY (route_provider_id) REFERENCES voice_route_providers(id) ON DELETE SET NULL;
  END IF;
END;
$$;

-- Link existing Telnyx sessions where possible without changing historical text fields.
UPDATE call_sessions cs
SET provider_id = vp.id
FROM voice_providers vp
WHERE vp.code = LOWER(COALESCE(cs.provider, ''))
  AND cs.provider_id IS NULL;

-- Create call_sessions router indexes using whichever timestamp
-- column is available in the existing schema.
DO $$
DECLARE
  v_timestamp_column TEXT;
BEGIN
  SELECT column_name
  INTO v_timestamp_column
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'call_sessions'
    AND column_name IN (
      'created_at',
      'started_at',
      'initiated_at',
      'answered_at',
      'updated_at'
    )
  ORDER BY CASE column_name
    WHEN 'created_at' THEN 1
    WHEN 'started_at' THEN 2
    WHEN 'initiated_at' THEN 3
    WHEN 'answered_at' THEN 4
    WHEN 'updated_at' THEN 5
    ELSE 99
  END
  LIMIT 1;

  IF v_timestamp_column IS NOT NULL THEN
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_call_sessions_provider_route
       ON call_sessions(provider_id, route_id, %I DESC)',
      v_timestamp_column
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_call_sessions_routing_failure
       ON call_sessions(routing_failure_code, %I DESC)
       WHERE routing_failure_code IS NOT NULL',
      v_timestamp_column
    );
  ELSE
    CREATE INDEX IF NOT EXISTS idx_call_sessions_provider_route
      ON call_sessions(provider_id, route_id);

    CREATE INDEX IF NOT EXISTS idx_call_sessions_routing_failure
      ON call_sessions(routing_failure_code)
      WHERE routing_failure_code IS NOT NULL;

    RAISE NOTICE
      'call_sessions has no recognized timestamp column; router indexes were created without timestamp ordering';
  END IF;
END;
$$;

-- -------------------------------------------------------------
-- 11. Safety constraints for newly populated commercial fields
--     Added as NOT VALID so existing historical data cannot block deploy.
-- -------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_call_rates_multi_provider_costs'
      AND conrelid = 'call_rates'::regclass
  ) THEN
    ALTER TABLE call_rates
      ADD CONSTRAINT chk_call_rates_multi_provider_costs
      CHECK (
        (platform_fee_usd_per_min IS NULL OR platform_fee_usd_per_min >= 0)
        AND (discounted_provider_rate_usd_per_min IS NULL OR discounted_provider_rate_usd_per_min > 0)
        AND (max_provider_rate_usd_per_min IS NULL OR max_provider_rate_usd_per_min > 0)
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_call_sessions_multi_provider_costs'
      AND conrelid = 'call_sessions'::regclass
  ) THEN
    ALTER TABLE call_sessions
      ADD CONSTRAINT chk_call_sessions_multi_provider_costs
      CHECK (
        (provider_discount_percent IS NULL OR
          (provider_discount_percent >= 0 AND provider_discount_percent <= 100))
        AND (provider_platform_fee_usd_per_min IS NULL OR
          provider_platform_fee_usd_per_min >= 0)
        AND (discounted_provider_rate_usd_per_min IS NULL OR
          discounted_provider_rate_usd_per_min > 0)
        AND (total_provider_cost_usd_per_min IS NULL OR
          total_provider_cost_usd_per_min > 0)
        AND (pricing_markup_percent IS NULL OR pricing_markup_percent >= 0)
        AND (pricing_min_profit_usd_per_min IS NULL OR
          pricing_min_profit_usd_per_min >= 0)
      ) NOT VALID;
  END IF;
END;
$$;

-- -------------------------------------------------------------
-- 12. Operational view for router/admin diagnostics
-- -------------------------------------------------------------
CREATE OR REPLACE VIEW voice_route_provider_status AS
SELECT
  vr.id AS route_id,
  vr.code AS route_code,
  vr.name AS route_name,
  vr.country_code,
  vr.prefix,
  vr.strategy,
  vr.is_active AS route_is_active,
  vr.max_provider_rate_usd_min AS route_max_provider_rate_usd_min,
  vrp.id AS route_provider_id,
  vrp.priority,
  vrp.weight,
  vrp.allow_fallback,
  vrp.is_active AS route_provider_is_active,
  vp.id AS provider_id,
  vp.code AS provider_code,
  vp.name AS provider_name,
  vp.status AS provider_status,
  vpp.id AS provider_plan_id,
  vpp.code AS provider_plan_code,
  vpp.plan_tier,
  COALESCE(vpp.discount_percent, 0.0000) AS discount_percent,
  COALESCE(
    vrp.platform_fee_usd_per_min,
    vpp.platform_fee_usd_per_min,
    vp.default_platform_fee_usd,
    0.0000000
  ) AS platform_fee_usd_per_min,
  vprc.id AS rate_card_id,
  vprc.code AS rate_card_code,
  vprc.is_active AS rate_card_is_active
FROM voice_routes vr
JOIN voice_route_providers vrp ON vrp.route_id = vr.id
JOIN voice_providers vp ON vp.id = vrp.provider_id
LEFT JOIN voice_provider_plans vpp ON vpp.id = vrp.provider_plan_id
LEFT JOIN voice_provider_rate_cards vprc ON vprc.id = vrp.rate_card_id;

COMMENT ON TABLE voice_providers IS
  'Registry of Telnyx and all current/future PSTN voice providers.';
COMMENT ON TABLE voice_provider_plans IS
  'Provider commercial plans, volume tiers, discounts, and platform fees.';
COMMENT ON TABLE voice_provider_rate_cards IS
  'Versioned provider-specific CSV/API/manual termination rate decks.';
COMMENT ON TABLE voice_provider_rates IS
  'Raw provider termination rates matched by longest E.164 prefix.';
COMMENT ON TABLE voice_destination_policies IS
  'Destination enablement, publication, maximum-cost, margin, and profit rules.';
COMMENT ON TABLE voice_routes IS
  'Logical country/prefix routes selected independently of Flutter.';
COMMENT ON TABLE voice_route_providers IS
  'Ordered provider candidates for priority/fallback or least-cost routing.';
COMMENT ON FUNCTION netphone_calculate_voice_price(NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC) IS
  'Calculates discounted provider cost, total cost, protected sell price, and profit.';

COMMIT;
