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


// ✅ Call Billing V2: Twilio completed callback থেকে charge করবে
async function billCompletedCallBySid({ callSid, durationSec, rawPayload }) {
  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    const s = await client.query(
      `
      SELECT *
      FROM call_sessions
      WHERE twilio_call_sid = $1
      FOR UPDATE
      `,
      [callSid]
    );

    const session = s.rows[0];

    if (!session) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "session_not_found" };
    }

    // Already charged হলে আবার charge করবে না
    if (session.status === "charged" || Number(session.charged_amount_cents || 0) > 0) {
      await client.query("ROLLBACK");
      return { ok: true, reason: "already_charged" };
    }

    const safeDurationSec = Math.max(0, Number(durationSec || 0));

    // duration 0 হলে charge করবে না
    if (safeDurationSec <= 0) {
      await client.query(
        `
        UPDATE call_sessions
        SET status = 'completed',
            provider_status = 'completed',
            ended_at = NOW(),
            duration_sec = 0,
            billing_source = 'twilio_callback',
            status_callback_payload = $2
        WHERE id = $1
        `,
        [session.id, rawPayload || {}]
      );

      await client.query("COMMIT");
      return { ok: true, reason: "no_charge_zero_duration" };
    }

    // Telecom billing: প্রতি শুরু হওয়া মিনিট charge
    const chargedMinutes = Math.max(1, Math.ceil(safeDurationSec / 60));
    const amountCents = chargedMinutes * Number(session.price_per_min_cents);

    await client.query("COMMIT");

    const debit = await walletService.applyWalletTx({
      userId: session.user_id,
      currency: session.currency,
      amountCents: -amountCents,
      txType: "call_charge",
      meta: {
        session_id: session.id,
        to_phone_e164: session.to_phone_e164,
        duration_sec: safeDurationSec,
        charged_minutes: chargedMinutes,
        call_sid: callSid,
      },
      idempotencyKey: `call_charge:${session.id}`,
    });

    if (!debit.ok) {
      await db.query(
        `
        UPDATE call_sessions
        SET status = 'failed',
            provider_status = 'completed',
            ended_at = NOW(),
            duration_sec = $2,
            charged_minutes = $3,
            charged_amount_cents = $4,
            billing_source = 'twilio_callback',
            status_callback_payload = $5
        WHERE id = $1
        `,
        [session.id, safeDurationSec, chargedMinutes, amountCents, rawPayload || {}]
      );

      return { ok: false, reason: debit.reason || "wallet_debit_failed" };
    }

    const providerCost = 0;
    const profit = amountCents - providerCost;

    await db.query(
      `
      UPDATE call_sessions
      SET status = 'charged',
          provider_status = 'completed',
          ended_at = NOW(),
          duration_sec = $2,
          charged_minutes = $3,
          charged_amount_cents = $4,
          tx_id = $5,
          provider_cost_cents = $6,
          profit_cents = $7,
          billing_source = 'twilio_callback',
          status_callback_payload = $8
      WHERE id = $1
      `,
      [
        session.id,
        safeDurationSec,
        chargedMinutes,
        amountCents,
        debit.tx?.id || null,
        providerCost,
        profit,
        rawPayload || {},
      ]
    );

    return {
      ok: true,
      charged_amount_cents: amountCents,
      charged_minutes: chargedMinutes,
      wallet: debit.wallet,
      tx: debit.tx,
    };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw e;
  } finally {
    client.release();
  }
}


module.exports = {
  startCallSession,
  endCallAndCharge,
  billCompletedCallBySid,
};
