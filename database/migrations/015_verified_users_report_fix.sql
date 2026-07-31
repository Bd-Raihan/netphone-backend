BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN users.phone_verified_at IS
  'The latest successful OTP verification time. NULL means the phone number is not confirmed.';

CREATE INDEX IF NOT EXISTS idx_users_phone_verified_at
  ON users (phone_verified_at DESC)
  WHERE phone_verified_at IS NOT NULL;

/*
 * Existing genuine users backfill:
 *
 * 1. Admin account
 * 2. Successful login recorded after migration 014
 * 3. User has at least one call session
 * 4. User has at least one wallet transaction
 * 5. User has at least one crypto recharge request
 *
 * OTP request করে account তৈরি হলেও কোনো real activity না থাকলে
 * সেই row registered user হিসেবে ধরা হবে না।
 */
UPDATE users u
SET phone_verified_at =
  COALESCE(
    u.last_login_at,
    u.created_at
  )
WHERE u.phone_verified_at IS NULL
  AND (
    u.role = 'admin'
    OR u.last_login_at IS NOT NULL

    OR EXISTS (
      SELECT 1
      FROM call_sessions cs
      WHERE cs.user_id = u.id
    )

    OR EXISTS (
      SELECT 1
      FROM wallet_transactions wt
      WHERE wt.user_id = u.id
    )

    OR EXISTS (
      SELECT 1
      FROM crypto_recharge_requests crr
      WHERE crr.user_id = u.id
    )
  );

COMMIT;