BEGIN;
-- Presentation-only reset. Never deletes calls or touches user/wallet/payment/Fax rows.
ALTER TABLE voice_guard_settings ADD COLUMN IF NOT EXISTS reporting_started_at TIMESTAMPTZ;
COMMIT;
