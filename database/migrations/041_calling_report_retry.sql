BEGIN;
-- Additive calling-report state only; no historical billing or wallet changes.
ALTER TABLE voice_guard_settings ADD COLUMN IF NOT EXISTS monitor_retry_after TIMESTAMPTZ;
COMMIT;
