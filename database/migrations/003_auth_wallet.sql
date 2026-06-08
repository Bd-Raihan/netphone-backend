-- =========================================
-- 003_auth_wallet.sql
-- কাজ:
-- 1) users table (phone-based)
-- 2) otp_codes (MVP/dev OTP)
-- 3) wallets (balance cents - নিরাপদ)
-- 4) wallet_transactions (ledger - সব টাকা লগ)
-- =========================================

BEGIN;

-- ✅ 1) users
-- Phone number আমরা E.164 ফরম্যাটে রাখবো যেমন: +965xxxxxxxx
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  phone_e164 VARCHAR(20) NOT NULL UNIQUE,
  country_code VARCHAR(5),
  status VARCHAR(20) NOT NULL DEFAULT 'active', -- active / blocked
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ✅ 2) otp_codes
-- OTP brute-force ঠেকাতে attempts রাখছি
CREATE TABLE IF NOT EXISTS otp_codes (
  id BIGSERIAL PRIMARY KEY,
  phone_e164 VARCHAR(20) NOT NULL,
  code VARCHAR(10) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index: একই ফোনের OTP দ্রুত খুঁজতে
CREATE INDEX IF NOT EXISTS idx_otp_phone_created
ON otp_codes (phone_e164, created_at DESC);

-- ✅ 3) wallets
-- টাকা/ব্যালেন্স সবসময় integer cents এ রাখবো (float নয়)
-- উদাহরণ: $5 = 500 cents
CREATE TABLE IF NOT EXISTS wallets (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  balance_cents BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (balance_cents >= 0)
);

-- ✅ 4) wallet_transactions (Ledger)
-- প্রতিটি add/debit/refund বাধ্যতামূলকভাবে এখানে লগ হবে
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL, -- topup / debit / refund / adjust
  amount_cents BIGINT NOT NULL, -- + বা - হতে পারে
  reference VARCHAR(100), -- payment_id / call_id / admin_note
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_created
ON wallet_transactions (user_id, created_at DESC);

COMMIT;
