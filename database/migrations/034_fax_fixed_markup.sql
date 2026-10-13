BEGIN;
-- Only future Fax pricing changes. Historical quotes/bills/wallet entries stay intact.
UPDATE netphone_fax_rates
SET markup_basis_points=4000, manual_sell_microusd_per_page=NULL,
    revision=revision+1, updated_at=NOW()
WHERE markup_basis_points<>4000 OR manual_sell_microusd_per_page IS NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='netphone_fax_rates'::regclass AND conname='netphone_fax_fixed_markup') THEN
  ALTER TABLE netphone_fax_rates ADD CONSTRAINT netphone_fax_fixed_markup
    CHECK (markup_basis_points=4000 AND manual_sell_microusd_per_page IS NULL);
 END IF;
END $$;
-- No provider rates seeded and charging is not enabled by this migration.
COMMIT;
