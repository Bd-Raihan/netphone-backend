BEGIN;

-- =========================================================
-- NetPhone Admin Country Pricing
--
-- Existing call_rates table-কে নষ্ট না করে শুধু
-- Admin pricing management-এর audit/config fields যোগ করবে।
-- =========================================================

ALTER TABLE call_rates
  ADD COLUMN IF NOT EXISTS pricing_mode VARCHAR(30),

  ADD COLUMN IF NOT EXISTS manual_rate_updated_by BIGINT,

  ADD COLUMN IF NOT EXISTS manual_rate_updated_at TIMESTAMPTZ,

  ADD COLUMN IF NOT EXISTS manual_rate_note TEXT;


-- Existing rows-এর mode safely নির্ধারণ।
UPDATE call_rates
SET pricing_mode =
  CASE
    WHEN COALESCE(manual_override, FALSE) = TRUE
      THEN 'manual_rate'
    ELSE 'auto_markup'
  END
WHERE pricing_mode IS NULL;


ALTER TABLE call_rates
  ALTER COLUMN pricing_mode
  SET DEFAULT 'auto_markup';

ALTER TABLE call_rates
  ALTER COLUMN pricing_mode
  SET NOT NULL;


-- Allowed pricing modes।
ALTER TABLE call_rates
  DROP CONSTRAINT IF EXISTS
  chk_call_rates_pricing_mode;

ALTER TABLE call_rates
  ADD CONSTRAINT chk_call_rates_pricing_mode
  CHECK (
    pricing_mode IN (
      'auto_markup',
      'manual_rate'
    )
  );


-- Admin user audit foreign key।
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'fk_call_rates_manual_rate_updated_by'
      AND conrelid =
        'call_rates'::regclass
  ) THEN
    ALTER TABLE call_rates
      ADD CONSTRAINT
        fk_call_rates_manual_rate_updated_by

      FOREIGN KEY (
        manual_rate_updated_by
      )

      REFERENCES users(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;


-- Validation constraints।
ALTER TABLE call_rates
  DROP CONSTRAINT IF EXISTS
  chk_call_rates_manual_sell_rate;

ALTER TABLE call_rates
  ADD CONSTRAINT
    chk_call_rates_manual_sell_rate

  CHECK (
    sell_rate_usd_per_min IS NULL
    OR sell_rate_usd_per_min > 0
  )
  NOT VALID;


ALTER TABLE call_rates
  DROP CONSTRAINT IF EXISTS
  chk_call_rates_manual_markup;

ALTER TABLE call_rates
  ADD CONSTRAINT
    chk_call_rates_manual_markup

  CHECK (
    markup_percent IS NULL
    OR (
      markup_percent >= 0
      AND markup_percent <= 1000
    )
  )
  NOT VALID;


-- Fast Admin lookup।
CREATE INDEX IF NOT EXISTS
  idx_call_rates_admin_country_pricing

ON call_rates (
  country_code,
  pricing_mode,
  manual_override,
  is_active
);


CREATE INDEX IF NOT EXISTS
  idx_call_rates_manual_override_prefix

ON call_rates (
  prefix,
  manual_override,
  publish_rate,
  is_active
)

WHERE manual_override = TRUE;


COMMENT ON COLUMN
  call_rates.pricing_mode
IS
  'auto_markup uses dynamic route/provider pricing; manual_rate uses explicit Admin sell rate.';


COMMENT ON COLUMN
  call_rates.manual_rate_updated_by
IS
  'Admin user who most recently changed the country retail pricing.';


COMMENT ON COLUMN
  call_rates.manual_rate_note
IS
  'Optional Admin note explaining the country pricing change.';


COMMIT;