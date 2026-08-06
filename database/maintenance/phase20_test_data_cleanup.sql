-- ============================================================
-- NetPhone Payment Engine
-- Phase-20 pre-production test-data cleanup
--
-- IMPORTANT:
-- This is a one-time production maintenance script.
-- It is NOT a database migration.
--
-- Successfully executed on production:
-- 2026-08-05 / 2026-08-06
--
-- Preserved:
--   Payment Order ID 2
--   Wallet Transaction ID 237
--
-- Cancelled:
--   Test Payment Orders 1 and 3
--   Their unfinished reconciliation jobs
-- ============================================================

BEGIN;

-- Cancel only unfinished Phase-20 test orders.
-- Successful credited Order 2 is intentionally excluded.
UPDATE payment_orders
SET
    status = 'cancelled',
    review_reason = 'Phase-20 pre-production test cleanup',
    next_verification_at = NULL,
    metadata = COALESCE(metadata, '{}'::jsonb)
        || jsonb_build_object(
            'cleanup_reason', 'phase20_final_cleanup',
            'cleanup_at', NOW()
        ),
    updated_at = NOW()
WHERE id IN (1, 3)
  AND wallet_tx_id IS NULL
  AND credited_at IS NULL
  AND status IN (
      'created',
      'awaiting_payment',
      'payment_detected',
      'confirming',
      'manual_review'
  );

-- Cancel unfinished reconciliation jobs linked to those orders.
UPDATE payment_reconciliation_jobs
SET
    job_status = 'cancelled',
    next_attempt_at = NOW(),
    locked_at = NULL,
    locked_by = NULL,
    last_finished_at = NOW(),
    last_error_code = 'phase20_test_cleanup',
    last_error_message =
        'Cancelled during Phase-20 production cleanup',
    result_payload = COALESCE(result_payload, '{}'::jsonb)
        || jsonb_build_object(
            'result', 'cancelled',
            'reason', 'phase20_final_cleanup',
            'cleanup_at', NOW()
        ),
    updated_at = NOW()
WHERE payment_order_id IN (1, 3)
  AND job_status <> 'completed';

COMMIT;