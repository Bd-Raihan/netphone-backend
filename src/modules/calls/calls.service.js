const db = require("../../config/db");
const walletService = require("../wallet/wallet.service");

// 1) rate lookup by prefix (simple MVP)
async function findRateByToPhone(toPhoneE164) {
  // Longest prefix match would be better; MVP: simple order by length desc
  const { rows } = await db.query(
    `
    SELECT id, prefix, currency, price_per_min_cents
    FROM call_rates
    WHERE is_active = true AND replace($1,'+','') LIKE prefix || '%'
    ORDER BY LENGTH(prefix) DESC
    LIMIT 1
    `,
    [toPhoneE164]
  );
  return rows[0] || null;
}


// 2) create session
async function startCallSession({ userId, toPhoneE164, meta = null }) {
  const rate = await findRateByToPhone(toPhoneE164);
  if (!rate) return { ok: false, reason: "rate_not_found" };
  await walletService.ensureWallet(userId);
  const wallet = await walletService.getWalletByUserId(userId);
  if (!wallet) {
  return { ok: false, reason: "wallet_not_found" };
}

const oneMinuteCost = Number(rate.price_per_min_cents);

if (Number(wallet.balance_cents) < oneMinuteCost) {
  return {
    ok: false,
    reason: "insufficient_balance_for_call",
  };
}

  
  const { rows } = await db.query(
    `
    INSERT INTO call_sessions
      (user_id, to_phone_e164, rate_id, currency, price_per_min_cents, status, meta)
    VALUES
      ($1, $2, $3, $4, $5, 'started', $6)
    RETURNING id, user_id, to_phone_e164, currency, price_per_min_cents, status, started_at
    `,
    [userId, toPhoneE164, rate.id, rate.currency, rate.price_per_min_cents, meta]
  );

  return { ok: true, session: rows[0] };
}

// 3) end session + charge wallet
async function endCallAndCharge({ userId, sessionId }) {
  // lock the session row
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const s = await client.query(
      `
      SELECT *
      FROM call_sessions
      WHERE id = $1 AND user_id = $2
      FOR UPDATE
      `,
      [sessionId, userId]
    );

    const session = s.rows[0];
    if (!session) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "session_not_found" };
    }
    if (session.status !== "started") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "invalid_state" };
    }

    const endedAt = new Date();
    const startedAt = new Date(session.started_at);
    const durationSec = Math.max(0, Math.floor((endedAt - startedAt) / 1000));

    // billing: ceil to minutes (MVP)
    const minutes = Math.max(1, Math.ceil(durationSec / 60));
    const amountCents = minutes * Number(session.price_per_min_cents);

    // mark ended first
    await client.query(
      `
      UPDATE call_sessions
      SET ended_at = NOW(), duration_sec = $2, status = 'ended'
      WHERE id = $1
      `,
      [sessionId, durationSec]
    );

    await client.query("COMMIT");

    // charge using wallet atomic function (your Step 3B)
    // negative amount for debit
    const txType = "call_charge";
    const debit = await walletService.applyWalletTx({
      userId,
      currency: session.currency,
      amountCents: -amountCents,
      txType,
      meta: { session_id: sessionId, minutes, durationSec },
      idempotencyKey: `call_charge:${sessionId}`,
    });

    if (!debit.ok) {
      // insufficient balance etc.
      await db.query(
        `UPDATE call_sessions SET status='failed', charged_amount_cents=$2 WHERE id=$1`,
        [sessionId, amountCents]
      );
      return { ok: false, reason: debit.reason || "charge_failed" };
    }

    // save tx ref
   // provider cost & profit
const providerCost = 0;
const profit = amountCents - providerCost;

// save tx ref
await db.query(
`
UPDATE call_sessions
SET
  status='charged',
  charged_amount_cents=$2,
  tx_id=$3,
  provider_cost_cents=$4,
  profit_cents=$5
WHERE id=$1
`,
[
  sessionId,
  amountCents,
  debit.tx?.id || null,
  providerCost,
  profit
]
);

    return { ok: true, charged_amount_cents: amountCents, wallet: debit.wallet, tx: debit.tx };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}


module.exports = {
  startCallSession,
  endCallAndCharge,
};
