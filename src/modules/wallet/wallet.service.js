const db = require("../../config/db");

async function getWalletByUserId(userId) {
  const { rows } = await db.query(
    `SELECT user_id, currency, balance_cents, updated_at
     FROM wallets
     WHERE user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

// ✅ ensure wallet row exists (সেফটি)
async function ensureWallet(userId, currency = "USD") {
  await db.query(
    `INSERT INTO wallets (user_id, currency, balance_cents)
     VALUES ($1, $2, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, currency]
  );
  return getWalletByUserId(userId);
}

// ✅ transaction apply (atomic) — balance update + tx insert
// ✅ transaction apply (atomic) — balance update + tx insert
async function applyWalletTx({
  userId,
  currency = "USD",
  amountCents,
  txType, // 'admin_credit' | 'admin_debit' | 'call_charge' | ...
  direction, // legacy support: 'credit' | 'debit' (পুরাতন কোড ভাঙবে না)
  idempotencyKey = null,
  meta = null,
}) {
  // ✅ backward compatible mapping (direction -> txType)
  const finalTxType =
    txType ||
    (direction === "credit"
      ? "admin_credit"
      : direction === "debit"
      ? "admin_debit"
      : null);

  if (!finalTxType) {
    throw new Error("tx_type_missing");
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    // ensure wallet exists
    await client.query(
      `INSERT INTO wallets (user_id, currency, balance_cents)
       VALUES ($1, $2, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, currency]
    );

    // wallet lock
    const w = await client.query(
      `SELECT user_id, currency, balance_cents
       FROM wallets
       WHERE user_id = $1
       FOR UPDATE`,
      [userId]
    );

    const wallet = w.rows[0];
    if (!wallet) throw new Error("wallet_missing");

    // idempotency check
    if (idempotencyKey) {
      const exist = await client.query(
        `SELECT id, amount_cents, balance_after_cents
         FROM wallet_transactions
         WHERE user_id = $1 AND idempotency_key = $2
         LIMIT 1`,
        [userId, idempotencyKey]
      );
      if (exist.rows[0]) {
        await client.query("COMMIT");
        return { ok: true, duplicated: true, wallet, tx: exist.rows[0] };
      }
    }

    let newBalance;

if (
  finalTxType === "admin_credit"
) {
  // টাকা যোগ হবে
  newBalance =
      Number(wallet.balance_cents) + Number(amountCents);
} else {
  // টাকা কাটবে
  newBalance =
      Number(wallet.balance_cents) - Number(amountCents);
}

    // ✅ insufficient balance rule (negative allow না)
    if (newBalance < 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "insufficient_balance" };
    }

    // meta jsonb safe
    const metaJson = meta ? JSON.stringify(meta) : null;

    // insert tx (type NOT NULL হবে)
    const ins = await client.query(
      `INSERT INTO wallet_transactions
        (user_id, type, amount_cents, status, idempotency_key, balance_after_cents, meta)
       VALUES
        ($1, $2, $3, 'posted', $4, $5, $6::jsonb)
       RETURNING id, user_id, type, amount_cents, status, balance_after_cents, created_at`,
      [userId, finalTxType, amountCents, idempotencyKey, newBalance, metaJson]
    );

    // update wallet balance
    await client.query(
      `UPDATE wallets
       SET balance_cents = $2, updated_at = NOW()
       WHERE user_id = $1`,
      [userId, newBalance]
    );

    await client.query("COMMIT");

    const updatedWallet = await getWalletByUserId(userId);
    return { ok: true, wallet: updatedWallet, tx: ins.rows[0] };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}


async function listTransactions(userId, limit = 20) {
  const { rows } = await db.query(
    `SELECT id, type, amount_cents, status, balance_after_cents, created_at, meta
     FROM wallet_transactions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}


// ✅ Compatibility wrapper (পুরাতন controller/routes ভাঙবে না)
async function creditWallet({ userId, amountCents, currency, meta }) {
  return applyWalletTx({
    userId,
    amountCents,
    currency,
    txType: "admin_credit", // ✅ এখানে type fix
    meta,
  });
}

async function debitWallet({ userId, amountCents, currency, meta }) {
  return applyWalletTx({
    userId,
    amountCents,
    currency,
    txType: "admin_debit", // ✅ এখানে type fix
    meta,
  });
}



module.exports = {
  getWalletByUserId,
  ensureWallet,
  applyWalletTx,
  listTransactions,
  creditWallet,
  debitWallet,
};
