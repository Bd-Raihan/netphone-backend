BEGIN;

CREATE TABLE IF NOT EXISTS netphone_inbound_sms (
    id BIGSERIAL PRIMARY KEY,
    telnyx_message_id TEXT NOT NULL UNIQUE,
    from_number TEXT NOT NULL,
    to_number TEXT NOT NULL,
    message_body TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_netphone_inbound_sms_received
ON netphone_inbound_sms (received_at DESC);

CREATE INDEX IF NOT EXISTS idx_netphone_inbound_sms_expires
ON netphone_inbound_sms (expires_at);

COMMIT;
