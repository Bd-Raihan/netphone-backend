BEGIN;
-- Additive, rerunnable: never move the activation timestamp on repeat deployment.
ALTER TABLE netphone_fax_settings ADD COLUMN IF NOT EXISTS receive_auto_from TIMESTAMPTZ;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM netphone_fax_settings WHERE id=1 AND actual_billing=TRUE
 AND adapter_verified=TRUE AND deck_version IS NOT NULL) THEN
 RAISE EXCEPTION 'Verified actual Fax billing and rate deck are required';
 END IF;
END $$;
UPDATE netphone_fax_settings SET receive_auto_from=COALESCE(receive_auto_from,clock_timestamp()),
 billing_enabled=TRUE,updated_at=NOW() WHERE id=1;
COMMIT;
