BEGIN;

-- Additive Fax tables only. Existing Wallet/Calling tables and IRS files stay intact.
CREATE TABLE IF NOT EXISTS netphone_fax_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  billing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO netphone_fax_settings(id) VALUES(1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS netphone_fax_rates (
  id BIGSERIAL PRIMARY KEY,
  country_code VARCHAR(10) NOT NULL,
  country_name VARCHAR(120) NOT NULL,
  phone_prefix VARCHAR(15) NOT NULL CHECK (phone_prefix ~ '^[1-9][0-9]{0,14}$'),
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('outbound','inbound')),
  provider_cost_microusd_per_page BIGINT NOT NULL CHECK (provider_cost_microusd_per_page > 0),
  markup_basis_points INTEGER NOT NULL DEFAULT 4000 CHECK (markup_basis_points BETWEEN 0 AND 100000),
  manual_sell_microusd_per_page BIGINT,
  cost_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (phone_prefix,direction),
  CHECK (manual_sell_microusd_per_page IS NULL OR manual_sell_microusd_per_page >= provider_cost_microusd_per_page),
  CHECK (NOT is_active OR cost_confirmed)
);
COMMENT ON COLUMN netphone_fax_rates.provider_cost_microusd_per_page IS
  'Admin-confirmed total cost per page including Fax API and allocated SIP transmission costs. Not automatically inferred from Calling rates.';

CREATE TABLE IF NOT EXISTS netphone_fax_receivers (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  receive_code VARCHAR(24) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS netphone_fax_quotes (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upload_id BIGINT NOT NULL REFERENCES netphone_fax_uploads(id) ON DELETE CASCADE,
  to_number VARCHAR(30) NOT NULL,
  prepared_file_name VARCHAR(255) NOT NULL,
  file_sha256 VARCHAR(64) NOT NULL,
  pages INTEGER NOT NULL CHECK (pages BETWEEN 1 AND 350),
  amount_microusd BIGINT NOT NULL CHECK (amount_microusd > 0),
  rate_snapshot JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  state VARCHAR(12) NOT NULL DEFAULT 'quoted' CHECK (state IN ('quoted','submitted')),
  fax_id BIGINT UNIQUE REFERENCES netphone_faxes(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_netphone_fax_quotes_user ON netphone_fax_quotes(user_id,created_at);

CREATE TABLE IF NOT EXISTS netphone_fax_billing (
  fax_id BIGINT PRIMARY KEY REFERENCES netphone_faxes(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pages INTEGER NOT NULL CHECK (pages BETWEEN 1 AND 350),
  amount_microusd BIGINT NOT NULL CHECK (amount_microusd >= 0),
  rate_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  state VARCHAR(20) NOT NULL CHECK (state IN ('free','payment_due','prepaid','paid','refunded')),
  charged_tx_id BIGINT REFERENCES wallet_transactions(id) ON DELETE SET NULL,
  refunded_tx_id BIGINT REFERENCES wallet_transactions(id) ON DELETE SET NULL,
  submit_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_netphone_fax_billing_pending ON netphone_fax_billing(state,fax_id);

CREATE TABLE IF NOT EXISTS netphone_fax_incoming (
  fax_id BIGINT PRIMARY KEY REFERENCES netphone_faxes(id) ON DELETE CASCADE,
  vault_file_name VARCHAR(100) NOT NULL UNIQUE,
  file_sha256 VARCHAR(64) NOT NULL,
  source VARCHAR(30) NOT NULL CHECK (source IN ('provider_media','legacy_archive')),
  assigned_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ,
  verified_reference VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS netphone_fax_audit (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(40) NOT NULL,
  fax_id BIGINT REFERENCES netphone_faxes(id) ON DELETE SET NULL,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- No seeded destination prices: verified total carrier costs must be entered first.
-- Billing remains OFF until the admin enables it after the updated app is ready.
COMMIT;
