const db = require("../../config/db");
const walletService = require("../wallet/wallet.service");

// ===============================
// Call Rate Engine V3
// Twilio live rate + profit rule
// ===============================

const MARKUP_PERCENT = Number(process.env.CALL_MARKUP_PERCENT || 25);
const MIN_PROFIT_USD_PER_MIN = Number(process.env.CALL_MIN_PROFIT_USD_PER_MIN || 0.002);

function cleanPhone(phone) {
  return String(phone || "").replace("+", "").replace(/\D/g, "");
}

function round5(n) {
  return Number(Number(n || 0).toFixed(5));
}

function makeSellRate(providerRate, markupPercent = MARKUP_PERCENT, minProfit = MIN_PROFIT_USD_PER_MIN) {
  const byPercent = providerRate * (1 + markupPercent / 100);
  const byMinProfit = providerRate + minProfit;
  return round5(Math.max(byPercent, byMinProfit));
}

function toUsdCents(usd) {
  return Math.round(Number(usd || 0) * 100);
}

function ceilMinutes(seconds) {
  if (Number(seconds || 0) <= 0) return 0;
  return Math.max(1, Math.ceil(Number(seconds) / 60));
}

async function fetchTwilioNumberRate(toPhoneE164) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) return null;

  const url = `https://pricing.twilio.com/v2/Voice/Numbers/${encodeURIComponent(toPhoneE164)}`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!res.ok) return null;

  const data = await res.json();
  const prices = data.outboundCallPrices || data.outbound_call_prices || [];
  const first = prices[0];

  if (!first) return null;

  const currentPrice = Number(first.currentPrice ?? first.current_price ?? first.basePrice ?? first.base_price);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;

  return {
    countryCode: data.isoCountry || data.iso_country || "XX",
    countryName: data.country || "International",
    providerRateUsdPerMin: round5(currentPrice),
  };
}

async function findRateByToPhone(toPhoneE164) {
  const phone = cleanPhone(toPhoneE164);

  // 1) Manual override থাকলে আগে DB rate ব্যবহার করবে
  const manual = await db.query(
    `
    SELECT *
    FROM call_rates
    WHERE is_active = true
      AND manual_override = true
      AND $1 LIKE prefix || '%'
    ORDER BY LENGTH(prefix) DESC
    LIMIT 1
    `,
    [phone]
  );

  if (manual.rows[0]) return manual.rows[0];

  // 2) Twilio live pricing
  const live = await fetchTwilioNumberRate(toPhoneE164);

  if (live) {
    const sellRate = makeSellRate(live.providerRateUsdPerMin);
    const legacyCents = Math.max(1, Math.ceil(sellRate * 100));

    // prefix হিসেবে full number max 16 digit রাখা হলো,
    // এতে সব দেশ dynamic হবে; পরে Admin Manager দিয়ে override করা যাবে।
    const prefix = phone.slice(0, 16);

    const upsert = await db.query(
      `
      INSERT INTO call_rates
        (
          country_code,
          country_name,
          prefix,
          currency,
          price_per_min_cents,
          provider,
          provider_rate_usd_per_min,
          sell_rate_usd_per_min,
          markup_percent,
          min_profit_usd_per_min,
          manual_override,
          rate_source,
          last_synced_at,
          is_active,
          updated_at
        )
      VALUES
        ($1,$2,$3,'USD',$4,'twilio',$5,$6,$7,$8,false,'twilio_live',NOW(),true,NOW())
      ON CONFLICT (prefix)
      DO UPDATE SET
        country_code = EXCLUDED.country_code,
        country_name = EXCLUDED.country_name,
        currency = 'USD',
        price_per_min_cents = EXCLUDED.price_per_min_cents,
        provider = 'twilio',
        provider_rate_usd_per_min = EXCLUDED.provider_rate_usd_per_min,
        sell_rate_usd_per_min = EXCLUDED.sell_rate_usd_per_min,
        markup_percent = EXCLUDED.markup_percent,
        min_profit_usd_per_min = EXCLUDED.min_profit_usd_per_min,
        rate_source = 'twilio_live',
        last_synced_at = NOW(),
        updated_at = NOW()
      WHERE call_rates.manual_override = false
      RETURNING *
      `,
      [
        live.countryCode,
        live.countryName,
        prefix,
        legacyCents,
        live.providerRateUsdPerMin,
        sellRate,
        MARKUP_PERCENT,
        MIN_PROFIT_USD_PER_MIN,
      ]
    );

    return upsert.rows[0];
  }

  // 3) fallback DB prefix rate
  const fallback = await db.query(
    `
    SELECT *
    FROM call_rates
    WHERE is_active = true
      AND $1 LIKE prefix || '%'
    ORDER BY LENGTH(prefix) DESC
    LIMIT 1
    `,
    [phone]
  );

  return fallback.rows[0] || null;
}

async function startCallSession({ userId, toPhoneE164, meta = null }) {
  const rate = await findRateByToPhone(toPhoneE164);
  if (!rate) return { ok: false, reason: "rate_not_found" };

  await walletService.ensureWallet(userId);
  const wallet = await walletService.getWalletByUserId(userId);
  if (!wallet) return { ok: false, reason: "wallet_not_found" };

  const sellRate = Number(rate.sell_rate_usd_per_min || rate.price_per_min_cents / 100);
  const oneMinuteCostCents = Math.max(1, toUsdCents(sellRate));

  if (Number(wallet.balance_cents) < oneMinuteCostCents) {
    return { ok: false, reason: "insufficient_balance_for_call" };
  }

  const { rows } = await db.query(
    `
    INSERT INTO call_sessions
      (
        user_id,
        to_phone_e164,
        rate_id,
        currency,
        price_per_min_cents,
        provider_rate_usd_per_min,
        sell_rate_usd_per_min,
        status,
        meta
      )
    VALUES
      ($1,$2,$3,'USD',$4,$5,$6,'started',$7)
    RETURNING *
    `,
    [
      userId,
      toPhoneE164,
      rate.id,
      oneMinuteCostCents,
      Number(rate.provider_rate_usd_per_min || 0),
      sellRate,
      meta,
    ]
  );

  return { ok: true, session: rows[0] };
}

async function endCallAndCharge({ userId, sessionId }) {
  return { ok: true, reason: "billing_by_twilio_callback_only" };
}

async function billCompletedCallBySid({ callSid, sessionId, rawPayload }) {
  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    const s = await client.query(
      `
      SELECT *
      FROM call_sessions
      WHERE twilio_call_sid = $1
         OR id = $2
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
      `,
      [callSid || null, Number(sessionId || 0)]
    );

    const session = s.rows[0];

    if (!session) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "session_not_found" };
    }

    if (session.status === "charged" || Number(session.charged_amount_cents || 0) > 0) {
      await client.query("COMMIT");
      return { ok: true, reason: "already_charged" };
    }

    if (!session.answered_at) {
      await client.query(
        `
        UPDATE call_sessions
        SET status = 'completed',
            provider_status = 'completed',
            ended_at = NOW(),
            duration_sec = 0,
            charged_minutes = 0,
            charged_amount_cents = 0,
            billing_source = 'answered_at_missing_no_charge',
            status_callback_payload = $2
        WHERE id = $1
        `,
        [session.id, rawPayload || {}]
      );

      await client.query("COMMIT");
      return { ok: true, reason: "no_charge_not_answered" };
    }

    const durationSec = Number(
    rawPayload?.CallDuration ??
    rawPayload?.Duration ??
    0
    );

const safeDurationSec = Math.max(0, Math.floor(durationSec));

    if (safeDurationSec <= 0) {
      await client.query(
        `
        UPDATE call_sessions
        SET status = 'completed',
            provider_status = 'completed',
            ended_at = NOW(),
            duration_sec = 0,
            charged_minutes = 0,
            charged_amount_cents = 0,
            billing_source = 'zero_answered_duration',
            status_callback_payload = $2
        WHERE id = $1
        `,
        [session.id, rawPayload || {}]
      );

      await client.query("COMMIT");
      return { ok: true, reason: "no_charge_zero_duration" };
    }

    const chargedMinutes = ceilMinutes(safeDurationSec);
    const sellRate = Number(session.sell_rate_usd_per_min || session.price_per_min_cents / 100);
    const providerRate = Number(session.provider_rate_usd_per_min || 0);

    const chargedUsd = round5(chargedMinutes * sellRate);
    const providerCostUsd = round5(chargedMinutes * providerRate);
    const profitUsd = round5(chargedUsd - providerCostUsd);

    const amountCents = Math.max(1, toUsdCents(chargedUsd));
    const providerCostCents = Math.max(0, toUsdCents(providerCostUsd));
    const profitCents = amountCents - providerCostCents;

    await client.query("COMMIT");

    const debit = await walletService.applyWalletTx({
      userId: session.user_id,
      currency: "USD",
      amountCents: amountCents,
      txType: "call_charge",
      meta: {
        session_id: session.id,
        to_phone_e164: session.to_phone_e164,
        duration_sec: safeDurationSec,
        charged_minutes: chargedMinutes,
        sell_rate_usd_per_min: sellRate,
        provider_rate_usd_per_min: providerRate,
        charged_usd: chargedUsd,
        provider_cost_usd: providerCostUsd,
        profit_usd: profitUsd,
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
            billing_source = 'wallet_debit_failed',
            status_callback_payload = $5
        WHERE id = $1
        `,
        [session.id, safeDurationSec, chargedMinutes, amountCents, rawPayload || {}]
      );

      return { ok: false, reason: debit.reason || "wallet_debit_failed" };
    }

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
          provider_cost_usd = $8,
          charged_amount_usd = $9,
          profit_usd = $10,
          billing_source = 'answered_at_backend_duration',
          status_callback_payload = $11
      WHERE id = $1
      `,
      [
        session.id,
        safeDurationSec,
        chargedMinutes,
        amountCents,
        debit.tx?.id || null,
        providerCostCents,
        profitCents,
        providerCostUsd,
        chargedUsd,
        profitUsd,
        rawPayload || {},
      ]
    );

    return {
      ok: true,
      duration_sec: safeDurationSec,
      charged_amount_cents: amountCents,
      charged_minutes: chargedMinutes,
      wallet: debit.wallet,
      tx: debit.tx,
    };
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
  billCompletedCallBySid,
  findRateByToPhone,
};