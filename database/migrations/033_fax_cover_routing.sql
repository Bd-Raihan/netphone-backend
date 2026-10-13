BEGIN;
CREATE TABLE IF NOT EXISTS public.netphone_fax_cover_codes (
 id UUID PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES public.users(id),
 token_hash CHAR(64) NOT NULL UNIQUE,
 destination VARCHAR(30) NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ,
 consumed_fax_id BIGINT UNIQUE REFERENCES public.netphone_faxes(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fax_cover_pending ON public.netphone_fax_cover_codes(user_id,expires_at);
GRANT SELECT, INSERT, UPDATE ON public.netphone_fax_cover_codes TO netphone_user;
COMMIT;
