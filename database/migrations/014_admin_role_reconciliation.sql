-- ============================================================================
-- 014_admin_role_reconciliation.sql
-- ============================================================================
--
-- Purpose:
--   Reconcile and permanently enforce the current NetPhone administrator.
--
-- Relationship with migration 008:
--   This migration is a corrective follow-up to:
--
--       008_set_bangladesh_admin.sql
--
--   Migration 008 attempted to:
--     1. Demote the former Kuwait administrator to normal user
--     2. Promote the Bangladesh number to administrator
--
--   However, 008 used UPDATE statements only. If the Bangladesh user did not
--   already exist, PostgreSQL returned UPDATE 0 and no administrator remained.
--
--   Migration 014 safely corrects that situation by:
--     1. Creating the Bangladesh user when missing
--     2. Creating its USD wallet when missing
--     3. Demoting the former Kuwait administrator
--     4. Demoting any other accidental administrators
--     5. Promoting exactly one Bangladesh administrator
--     6. Verifying that exactly one active administrator exists
--
-- Safety:
--   - Safe to run multiple times
--   - Does not delete users, wallets, transactions, calls, or history
--   - Preserves any existing Bangladesh-user wallet balance
--   - Uses a transaction and advisory lock
--
-- Current administrator:
--   +8801721763941
--
-- Former administrator:
--   +96598598703
-- ============================================================================

BEGIN;

-- Prevent two administrator-reconciliation operations from running concurrently.
SELECT pg_advisory_xact_lock(
    hashtext('netphone:admin-role-reconciliation')
);

-- ============================================================================
-- STEP 1
-- Ensure the Bangladesh administrator user exists.
--
-- Existing user:
--   role/status will be corrected.
--
-- Missing user:
--   a new active administrator row will be created.
-- ============================================================================

INSERT INTO users (
    phone_e164,
    role,
    status
)
VALUES (
    '+8801721763941',
    'admin',
    'active'
)
ON CONFLICT (phone_e164)
DO UPDATE SET
    role = EXCLUDED.role,
    status = EXCLUDED.status;

-- ============================================================================
-- STEP 2
-- Ensure the Bangladesh administrator has a USD wallet.
--
-- The existing wallet is never overwritten.
-- Therefore, an existing balance remains unchanged.
-- ============================================================================

INSERT INTO wallets (
    user_id,
    currency,
    balance_cents
)
SELECT
    u.id,
    'USD',
    0
FROM users u
WHERE u.phone_e164 = '+8801721763941'
  AND NOT EXISTS (
      SELECT 1
      FROM wallets w
      WHERE w.user_id = u.id
  );

-- ============================================================================
-- STEP 3
-- Demote every other administrator.
--
-- This includes:
--   - the former Kuwait administrator
--   - any accidental or stale administrator account
--
-- No account is deleted or blocked.
-- ============================================================================

UPDATE users
SET
    role = 'user'
WHERE role = 'admin'
  AND phone_e164 <> '+8801721763941';

-- ============================================================================
-- STEP 4
-- Explicitly keep the former Kuwait administrator as a normal active user.
-- ============================================================================

UPDATE users
SET
    role = 'user',
    status = 'active'
WHERE phone_e164 = '+96598598703';

-- ============================================================================
-- STEP 5
-- Re-assert the final administrator after all demotion operations.
-- ============================================================================

UPDATE users
SET
    role = 'admin',
    status = 'active'
WHERE phone_e164 = '+8801721763941';

-- ============================================================================
-- STEP 6
-- Production safety verification.
--
-- The migration will fail and roll back if:
--   - the Bangladesh administrator is missing
--   - it is not active/admin
--   - more than one administrator exists
--   - no administrator exists
--   - the administrator has no wallet
-- ============================================================================

DO $$
DECLARE
    v_target_admin_count INTEGER;
    v_total_admin_count INTEGER;
    v_target_wallet_count INTEGER;
BEGIN
    SELECT COUNT(*)
    INTO v_target_admin_count
    FROM users
    WHERE phone_e164 = '+8801721763941'
      AND role = 'admin'
      AND status = 'active';

    IF v_target_admin_count <> 1 THEN
        RAISE EXCEPTION
            'Admin reconciliation failed: Bangladesh administrator is missing or invalid';
    END IF;

    SELECT COUNT(*)
    INTO v_total_admin_count
    FROM users
    WHERE role = 'admin';

    IF v_total_admin_count <> 1 THEN
        RAISE EXCEPTION
            'Admin reconciliation failed: expected exactly 1 admin, found %',
            v_total_admin_count;
    END IF;

    SELECT COUNT(*)
    INTO v_target_wallet_count
    FROM wallets w
    JOIN users u
      ON u.id = w.user_id
    WHERE u.phone_e164 = '+8801721763941';

    IF v_target_wallet_count < 1 THEN
        RAISE EXCEPTION
            'Admin reconciliation failed: Bangladesh administrator wallet is missing';
    END IF;
END
$$;

COMMIT;

-- ============================================================================
-- Verification output
-- These read-only queries display the final result after successful COMMIT.
-- ============================================================================

SELECT
    id,
    phone_e164,
    role,
    status
FROM users
WHERE phone_e164 IN (
    '+96598598703',
    '+8801721763941'
)
ORDER BY id;

SELECT
    COUNT(*) AS total_admins
FROM users
WHERE role = 'admin';

SELECT
    u.id,
    u.phone_e164,
    u.role,
    u.status,
    w.currency,
    w.balance_cents
FROM users u
LEFT JOIN wallets w
  ON w.user_id = u.id
WHERE u.role = 'admin';