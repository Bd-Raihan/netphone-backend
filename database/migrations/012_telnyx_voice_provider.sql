BEGIN;

ALTER TABLE call_sessions
ADD COLUMN IF NOT EXISTS provider_call_id TEXT;

CREATE INDEX IF NOT EXISTS idx_call_sessions_provider_call_id
ON call_sessions(provider_call_id);

-- পুরোনো Twilio SID থাকলে generic column-এ backup copy
UPDATE call_sessions
SET provider_call_id = twilio_call_sid
WHERE provider_call_id IS NULL
  AND twilio_call_sid IS NOT NULL;

-- পুরোনো Twilio call session-গুলোকে historical provider হিসেবে চিহ্নিত করা
UPDATE call_sessions
SET provider = 'twilio'
WHERE twilio_call_sid IS NOT NULL
  AND provider_call_id = twilio_call_sid
  AND (
    provider IS NULL
    OR provider = ''
    OR provider = 'telnyx'
  );

COMMIT;