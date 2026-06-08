BEGIN;

-- 1) wallet_transactions এ নতুন কলাম add (যদি আগেই না থাকে)
ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS balance_after_cents bigint,
  ADD COLUMN IF NOT EXISTS meta jsonb,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'posted';

-- 2) status check (posted / pending / failed)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wallet_tx_status_check'
  ) THEN
    ALTER TABLE wallet_transactions
      ADD CONSTRAINT wallet_tx_status_check
      CHECK (status IN ('posted', 'pending', 'failed'));
  END IF;
END$$;

-- 3) idempotency unique (একই request দুইবার গেলে duplicate হবে না)
CREATE UNIQUE INDEX IF NOT EXISTS ux_wallet_tx_idempotency
  ON wallet_transactions(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 4) কিছু দরকারি index
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_created
  ON wallet_transactions(user_id, created_at DESC);

COMMIT;
