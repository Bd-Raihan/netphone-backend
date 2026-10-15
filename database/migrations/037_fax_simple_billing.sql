BEGIN;
-- Fax-only additive migration. No wallet changes or historical debits.
ALTER TABLE netphone_fax_autopay ADD COLUMN IF NOT EXISTS terms_version TEXT;
ALTER TABLE netphone_fax_billing ADD COLUMN IF NOT EXISTS reconcile_attempted_at TIMESTAMPTZ;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM netphone_fax_settings WHERE id=1 AND actual_billing=TRUE
 AND adapter_verified=TRUE AND deck_version IS NOT NULL) THEN
 RAISE EXCEPTION 'Verified actual Fax billing and rate deck are required';
 END IF;
END $$;
UPDATE netphone_fax_settings SET billing_enabled=TRUE,updated_at=NOW() WHERE id=1;
COMMIT;
