const db = require("../../config/db");

async function getPendingRecharges() {
  const result = await db.query(
    `
    SELECT
      cr.id,
      cr.user_id,
      cr.phone_e164,
      cr.amount_usd,
      cr.crypto_currency,
      cr.network,
      cr.wallet_address,
      cr.tx_hash,
      cr.status,
      cr.admin_note,
      cr.created_at,
      cr.updated_at
    FROM crypto_recharge_requests cr
    WHERE cr.status = 'pending'
    ORDER BY cr.created_at DESC
    `
  );

  return result.rows;
}

async function approveRecharge({ rechargeId, adminUserId }) {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const rechargeResult = await client.query(
      `
      SELECT *
      FROM crypto_recharge_requests
      WHERE id = $1
      FOR UPDATE
      `,
      [rechargeId]
    );

    if (rechargeResult.rowCount === 0) {
      throw new Error("Recharge request not found");
    }

    const recharge = rechargeResult.rows[0];

    if (recharge.status !== "pending") {
      throw new Error("Recharge request already processed");
    }

    const amountCents = Math.round(Number(recharge.amount_usd) * 100);

    if (!amountCents || amountCents <= 0) {
      throw new Error("Invalid recharge amount");
    }

    const walletResult = await client.query(
      `
      UPDATE wallets
      SET balance_cents = balance_cents + $1,
          updated_at = NOW()
      WHERE user_id = $2
      RETURNING user_id, balance_cents
      `,
      [amountCents, recharge.user_id]
    );

    if (walletResult.rowCount === 0) {
      throw new Error("User wallet not found");
    }

    const balanceAfterCents = walletResult.rows[0].balance_cents;

    await client.query(
      `
      INSERT INTO wallet_transactions
      (
        user_id,
        type,
        amount_cents,
        reference,
        balance_after_cents,
        meta,
        status
      )
      VALUES
      (
        $1,
        'recharge',
        $2,
        $3,
        $4,
        $5,
        'posted'
      )
      `,
      [
        recharge.user_id,
        amountCents,
        `crypto_recharge_${recharge.id}`,
        balanceAfterCents,
        {
          source: "crypto",
          currency: recharge.crypto_currency,
          network: recharge.network,
          tx_hash: recharge.tx_hash,
          approved_by: adminUserId,
        },
      ]
    );

    const updateResult = await client.query(
      `
      UPDATE crypto_recharge_requests
      SET status = 'approved',
          approved_by = $1,
          approved_at = NOW(),
          updated_at = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [adminUserId, rechargeId]
    );

    await client.query("COMMIT");

    return {
      recharge: updateResult.rows[0],
      balance_cents: balanceAfterCents,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function rejectRecharge({ rechargeId, adminUserId, adminNote }) {
  const result = await db.query(
    `
    UPDATE crypto_recharge_requests
    SET status = 'rejected',
        approved_by = $1,
        admin_note = $2,
        updated_at = NOW()
    WHERE id = $3
      AND status = 'pending'
    RETURNING *
    `,
    [adminUserId, adminNote || "Rejected by admin", rechargeId]
  );

  if (result.rowCount === 0) {
    throw new Error("Recharge request not found or already processed");
  }

  return result.rows[0];
}

module.exports = {
  getPendingRecharges,
  approveRecharge,
  rejectRecharge,
};