const db = require("../../config/db");
const crypto = require("crypto");

async function findUserByPhone(phone) {
  const { rows } = await db.query(
    "SELECT * FROM users WHERE phone_e164 = $1",
    [phone]
  );
  return rows[0];
}

async function createUserWithWallet(phone) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const userRes = await client.query(
      `INSERT INTO users (phone_e164)
       VALUES ($1)
       RETURNING *`,
      [phone]
    );

    const user = userRes.rows[0];

    await client.query(
      `INSERT INTO wallets (user_id, currency, balance_cents)
       VALUES ($1, 'USD', 0)`,
      [user.id]
    );

    await client.query("COMMIT");
    return user;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function markUserLogin(userId) {
  const { rows } = await db.query(
    `UPDATE users
     SET last_login_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [userId]
  );
  return rows[0];
}

async function createOtp(phone, expiresMin) {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + expiresMin * 60000);

  await db.query(
    `INSERT INTO otp_codes (phone_e164, code, expires_at)
     VALUES ($1, $2, $3)`,
    [phone, code, expiresAt]
  );

  return { code, expires_at: expiresAt };
}

async function verifyOtp(phone, code) {
  const { rows } = await db.query(
    `SELECT * FROM otp_codes
     WHERE phone_e164 = $1
       AND code = $2
       AND expires_at > NOW()
     ORDER BY id DESC
     LIMIT 1`,
    [phone, code]
  );

  if (!rows.length) {
    return { ok: false, reason: "invalid_or_expired" };
  }

  await db.query("DELETE FROM otp_codes WHERE id = $1", [rows[0].id]);
  return { ok: true };
}

module.exports = {
  findUserByPhone,
  createUserWithWallet,
  markUserLogin,
  createOtp,
  verifyOtp,
};
