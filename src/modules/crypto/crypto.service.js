const pool = require("../../config/db");

function usdToCents(amountUsd) {
  return Math.round(Number(amountUsd) * 100);
}

async function createRechargeRequest(user, payload) {
  const amountCents = usdToCents(payload.amount_usd);

  const result = await pool.query(
    `
    INSERT INTO crypto_recharge_requests
      (user_id, phone_e164, amount_usd, crypto_currency, network, wallet_address, tx_hash, status)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, 'pending')
    RETURNING *
    `,
    [
      user.id,
      user.phone_e164,
      payload.amount_usd,
      payload.crypto_currency || "USDT",
      payload.network || "TRC20",
      payload.wallet_address || null,
      payload.tx_hash,
    ]
  );

  return result.rows[0];
}

async function getMyRechargeRequests(userId) {
  const result = await pool.query(
    `
    SELECT *
    FROM crypto_recharge_requests
    WHERE user_id = $1
    ORDER BY created_at DESC
    `,
    [userId]
  );

  return result.rows;
}

async function getAdminRechargeRequests(status = "pending") {
  const result = await pool.query(
    `
    SELECT *
    FROM crypto_recharge_requests
    WHERE status = $1
    ORDER BY created_at DESC
    `,
    [status]
  );

  return result.rows;
}

async function approveRechargeRequest(adminUser, requestId, adminNote = "") {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const requestResult = await client.query(
      `
      SELECT *
      FROM crypto_recharge_requests
      WHERE id = $1
      FOR UPDATE
      `,
      [requestId]
    );

    if (requestResult.rowCount === 0) {
      throw new Error("Recharge request not found");
    }

    const request = requestResult.rows[0];

    if (request.status !== "pending") {
      throw new Error("Recharge request already processed");
    }

    const amountCents = usdToCents(request.amount_usd);

    await client.query(
      `
      INSERT INTO wallets (user_id, currency, balance_cents)
      VALUES ($1, 'USD', 0)
      ON CONFLICT (user_id) DO NOTHING
      `,
      [request.user_id]
    );

    const walletResult = await client.query(
      `
      SELECT *
      FROM wallets
      WHERE user_id = $1
      FOR UPDATE
      `,
      [request.user_id]
    );

    const currentBalance = Number(walletResult.rows[0].balance_cents || 0);
    const newBalance = currentBalance + amountCents;

    await client.query(
      `
      UPDATE wallets
      SET balance_cents = $1,
          updated_at = now()
      WHERE user_id = $2
      `,
      [newBalance, request.user_id]
    );

    const idempotencyKey = `crypto_recharge_${request.id}`;

    await client.query(
      `
      INSERT INTO wallet_transactions
        (user_id, type, amount_cents, reference, idempotency_key, balance_after_cents, meta, status)
      VALUES
        ($1, 'crypto_recharge', $2, $3, $4, $5, $6, 'posted')
      ON CONFLICT (user_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
      DO NOTHING
      `,
      [
        request.user_id,
        amountCents,
        `CRYPTO_RECHARGE_${request.id}`,
        idempotencyKey,
        newBalance,
        {
          crypto_currency: request.crypto_currency,
          network: request.network,
          tx_hash: request.tx_hash,
          approved_by: adminUser.id,
        },
      ]
    );

    const updatedRequest = await client.query(
      `
      UPDATE crypto_recharge_requests
      SET status = 'approved',
          admin_note = $1,
          approved_by = $2,
          approved_at = now(),
          updated_at = now()
      WHERE id = $3
      RETURNING *
      `,
      [adminNote, adminUser.id, request.id]
    );

    await client.query("COMMIT");

    return {
      request: updatedRequest.rows[0],
      balance_cents: newBalance,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function rejectRechargeRequest(adminUser, requestId, adminNote) {
  const result = await pool.query(
    `
    UPDATE crypto_recharge_requests
    SET status = 'rejected',
        admin_note = $1,
        approved_by = $2,
        approved_at = now(),
        updated_at = now()
    WHERE id = $3
      AND status = 'pending'
    RETURNING *
    `,
    [adminNote, adminUser.id, requestId]
  );

  if (result.rowCount === 0) {
    throw new Error("Recharge request not found or already processed");
  }

  return result.rows[0];
}

function getCryptoConfig() {
  return {
    crypto_currency: "USDT",
    network: "TRC20",
    wallet_address: process.env.USDT_TRC20_WALLET_ADDRESS,
    min_amount_usd: 5,
    max_amount_usd: 500,
    note: "Send only USDT on TRC20 network. Sending other coins or networks may result in permanent loss.",
  };
}



module.exports = {
  createRechargeRequest,
  getMyRechargeRequests,
  getAdminRechargeRequests,
  approveRechargeRequest,
  rejectRechargeRequest,
  getCryptoConfig,
};