BEGIN;

-- =========================================================
-- Per-user Telnyx WebRTC credential mapping
-- =========================================================

CREATE TABLE IF NOT EXISTS voice_user_credentials (
    id BIGSERIAL PRIMARY KEY,

    user_id BIGINT NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    provider_code VARCHAR(50) NOT NULL,

    provider_credential_id TEXT NOT NULL,

    connection_id TEXT NOT NULL,

    status VARCHAR(30) NOT NULL DEFAULT 'active',

    credential_expires_at TIMESTAMPTZ,

    last_token_issued_at TIMESTAMPTZ,

    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_voice_user_credentials_user_provider
        UNIQUE (user_id, provider_code),

    CONSTRAINT uq_voice_user_credentials_provider_credential
        UNIQUE (provider_code, provider_credential_id),

    CONSTRAINT chk_voice_user_credentials_status
        CHECK (
            status IN (
                'active',
                'expired',
                'revoked',
                'failed'
            )
        )
);

CREATE INDEX IF NOT EXISTS
    idx_voice_user_credentials_expiry
ON voice_user_credentials(credential_expires_at);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = 'netphone_user'
    ) THEN

        GRANT SELECT, INSERT, UPDATE, DELETE
        ON TABLE voice_user_credentials
        TO netphone_user;

        GRANT USAGE, SELECT, UPDATE
        ON SEQUENCE voice_user_credentials_id_seq
        TO netphone_user;

        ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE
        ON TABLES TO netphone_user;

        ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE, SELECT, UPDATE
        ON SEQUENCES TO netphone_user;
    END IF;
END
$$;

COMMIT;