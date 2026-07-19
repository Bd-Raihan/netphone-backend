const db = require("../../config/db");
const walletService = require("../wallet/wallet.service");
const providerRouter = require("./provider-router.service");

/**
 * Monetary database snapshots-এর জন্য সর্বোচ্চ 7 decimal রাখা হয়।
 */
function round7(value) {
  return Number(Number(value || 0).toFixed(7));
}

/**
 * Existing wallet engine cent-based হওয়ায় এক মিনিটের sell rate
 * USD cents-এ convert করে।
 *
 * উদাহরণ:
 * 0.0125 USD -> 1 cent
 * 0.0270 USD -> 3 cents
 */
function toUsdCents(usd) {
  return Math.max(
    0,
    Math.ceil(Number(usd || 0) * 100)
  );
}

/**
 * Current billing policy:
 * Answered call-এর duration প্রতি শুরু হওয়া minute অনুযায়ী charge হবে।
 */
function ceilMinutes(seconds) {
  const safeSeconds = Number(seconds || 0);

  if (!Number.isFinite(safeSeconds) || safeSeconds <= 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(safeSeconds / 60));
}

/**
 * Router result-কে existing calls.service-compatible rate shape-এ
 * normalize করে।
 */
function normalizeRouterRate(routerResult) {
  if (!routerResult?.ok) {
    return null;
  }

  const pricing = routerResult.pricing || {};
  const provider = routerResult.provider || {};
  const providerRate = routerResult.provider_rate || {};
  const route = routerResult.route || {};
  const routeProvider = routerResult.route_provider || {};
  const providerPlan = routerResult.provider_plan || {};
  const callRate = routerResult.call_rate || null;

  const rawProviderRate = Number(
    pricing.raw_provider_rate_usd_per_min ??
      providerRate.raw_rate_usd_per_min ??
      callRate?.provider_rate_usd_per_min ??
      0
  );

  const discountedProviderRate = Number(
    pricing.discounted_provider_rate_usd_per_min ??
      callRate?.discounted_provider_rate_usd_per_min ??
      rawProviderRate
  );

  const platformFee = Number(
    pricing.platform_fee_usd_per_min ??
      callRate?.platform_fee_usd_per_min ??
      0
  );

  const totalProviderCost = Number(
    pricing.total_provider_cost_usd_per_min ??
      discountedProviderRate + platformFee
  );

  const sellRate = Number(
    pricing.sell_rate_usd_per_min ??
      callRate?.sell_rate_usd_per_min ??
      Number(callRate?.price_per_min_cents || 0) / 100
  );

  if (
    !Number.isFinite(sellRate) ||
    sellRate <= 0
  ) {
    return null;
  }

  if (
    Number.isFinite(totalProviderCost) &&
    totalProviderCost > 0 &&
    sellRate <= totalProviderCost
  ) {
    return null;
  }

  return {
    id: callRate?.id || null,

    country_code:
      providerRate.country_code ||
      callRate?.country_code ||
      routerResult.destination_policy?.country_code ||
      route.country_code ||
      null,

    country_name:
      providerRate.country_name ||
      callRate?.country_name ||
      null,

    destination_name:
      providerRate.destination_name ||
      routerResult.destination_policy?.destination_name ||
      null,

    prefix:
      providerRate.prefix ||
      callRate?.prefix ||
      route.prefix ||
      null,

    currency:
      callRate?.currency || "USD",

    provider:
      provider.code ||
      callRate?.provider ||
      "telnyx",

    provider_id:
      provider.id ||
      callRate?.provider_id ||
      null,

    provider_plan_id:
      providerPlan.id ||
      callRate?.provider_plan_id ||
      null,

    provider_plan_code:
      providerPlan.code || null,

    provider_discount_percent: Number(
      pricing.discount_percent ??
        providerPlan.discount_percent ??
        0
    ),

    provider_rate_id:
      providerRate.provider_rate_id ||
      callRate?.provider_rate_id ||
      null,

    route_id:
      route.id ||
      callRate?.route_id ||
      null,

    route_provider_id:
      routeProvider.route_provider_id ||
      null,

    raw_provider_rate_usd_per_min:
      round7(rawProviderRate),

    discounted_provider_rate_usd_per_min:
      round7(discountedProviderRate),

    platform_fee_usd_per_min:
      round7(platformFee),

    total_provider_cost_usd_per_min:
      round7(totalProviderCost),

    provider_rate_usd_per_min:
      round7(rawProviderRate),

    sell_rate_usd_per_min:
      round7(sellRate),

    markup_percent: Number(
      pricing.markup_percent ??
        callRate?.markup_percent ??
        25
    ),

    min_profit_usd_per_min: Number(
      pricing.min_profit_usd_per_min ??
        callRate?.min_profit_usd_per_min ??
        0.002
    ),

    max_provider_rate_usd_per_min:
      routerResult.max_provider_rate_usd_per_min ??
      callRate?.max_provider_rate_usd_per_min ??
      null,

    price_per_min_cents: Math.max(
      1,
      Number(
        callRate?.price_per_min_cents ||
          toUsdCents(sellRate)
      )
    ),

    rate_source:
      routerResult.source ||
      callRate?.rate_source ||
      "multi_provider_router",

    route_attempts:
      routerResult.rejected_providers || [],

    router_fallback_reason:
      routerResult.router_fallback_reason || null,

    call_rate: callRate,
    router_result: routerResult,
  };
}

/**
 * Backward-compatible exported rate lookup.
 *
 * এখন এটি সরাসরি call_rates query না করে Provider Router ব্যবহার করে।
 */
async function findRateByToPhone(toPhoneE164) {
  const routerResult =
    await providerRouter.resolveDestination(toPhoneE164);

  if (!routerResult.ok) {
    console.warn(
      "⚠️ CALL ROUTER REJECTED DESTINATION:",
      {
        toPhoneE164,
        reason: routerResult.reason,
        disabledReason:
          routerResult.disabled_reason || null,
      }
    );

    return null;
  }

  const rate = normalizeRouterRate(routerResult);

  if (!rate) {
    console.error(
      "❌ ROUTER RETURNED INVALID PRICING:",
      {
        toPhoneE164,
        source: routerResult.source,
        provider: routerResult.provider?.code,
      }
    );

    return null;
  }

  return rate;
}

/**
 * Call শুরু করার আগে:
 *
 * 1. Destination validate
 * 2. Disabled policy check
 * 3. Route/provider/rate resolve
 * 4. Loss-protection check
 * 5. Wallet balance check
 * 6. Immutable routing/pricing snapshot save
 */
async function startCallSession({
  userId,
  toPhoneE164,
  meta = null,
}) {
  const routerResult =
    await providerRouter.resolveDestination(toPhoneE164);

  if (!routerResult.ok) {
    return {
      ok: false,
      reason:
        routerResult.reason ||
        "route_resolution_failed",
      message:
        routerResult.disabled_reason ||
        routerResult.reason ||
        "No safe call route is available",
      routing: routerResult,
    };
  }

  const rate = normalizeRouterRate(routerResult);

  if (!rate) {
    return {
      ok: false,
      reason: "invalid_router_pricing",
      message:
        "The selected route does not have safe pricing",
    };
  }

  const providerCode = String(
    rate.provider || ""
  )
    .trim()
    .toLowerCase();

  if (!providerCode) {
    return {
      ok: false,
      reason: "provider_not_selected",
      message: "No voice provider was selected",
    };
  }

  const sellRate = Number(
    rate.sell_rate_usd_per_min
  );

  const totalProviderCost = Number(
    rate.total_provider_cost_usd_per_min
  );

  if (
    !Number.isFinite(sellRate) ||
    sellRate <= 0
  ) {
    return {
      ok: false,
      reason: "invalid_sell_rate",
    };
  }

  if (
    Number.isFinite(totalProviderCost) &&
    totalProviderCost > 0 &&
    sellRate <= totalProviderCost
  ) {
    return {
      ok: false,
      reason: "sell_rate_not_above_cost",
    };
  }

  await walletService.ensureWallet(userId);

  const wallet =
    await walletService.getWalletByUserId(userId);

  if (!wallet) {
    return {
      ok: false,
      reason: "wallet_not_found",
    };
  }

  const oneMinuteCostCents = Math.max(
    1,
    toUsdCents(sellRate)
  );

  if (
    Number(wallet.balance_cents || 0) <
    oneMinuteCostCents
  ) {
    return {
      ok: false,
      reason: "insufficient_balance_for_call",
      required_balance_cents:
        oneMinuteCostCents,
      available_balance_cents: Number(
        wallet.balance_cents || 0
      ),
    };
  }

  const sessionMeta = {
    ...(meta || {}),

    router_source:
      rate.rate_source,

    selected_provider:
      providerCode,

    selected_route_id:
      rate.route_id,

    selected_route_provider_id:
      rate.route_provider_id,

    provider_plan_code:
      rate.provider_plan_code,

    matched_prefix:
      rate.prefix,

    router_fallback_reason:
      rate.router_fallback_reason,

    pricing_snapshot: {
      raw_provider_rate_usd_per_min:
        rate.raw_provider_rate_usd_per_min,

      provider_discount_percent:
        rate.provider_discount_percent,

      discounted_provider_rate_usd_per_min:
        rate.discounted_provider_rate_usd_per_min,

      platform_fee_usd_per_min:
        rate.platform_fee_usd_per_min,

      total_provider_cost_usd_per_min:
        rate.total_provider_cost_usd_per_min,

      sell_rate_usd_per_min:
        rate.sell_rate_usd_per_min,

      markup_percent:
        rate.markup_percent,

      min_profit_usd_per_min:
        rate.min_profit_usd_per_min,

      max_provider_rate_usd_per_min:
        rate.max_provider_rate_usd_per_min,
    },
  };

  const { rows } = await db.query(
    `
    INSERT INTO call_sessions
      (
        user_id,
        to_phone_e164,

        rate_id,
        currency,
        price_per_min_cents,

        provider,
        provider_id,
        provider_plan_id,
        provider_rate_id,

        route_id,
        route_provider_id,

        provider_plan_code,
        provider_discount_percent,

        provider_rate_usd_per_min,
        provider_platform_fee_usd_per_min,
        discounted_provider_rate_usd_per_min,
        total_provider_cost_usd_per_min,

        sell_rate_usd_per_min,
        pricing_markup_percent,
        pricing_min_profit_usd_per_min,

        route_attempts,

        status,
        meta
      )
    VALUES
      (
        $1,
        $2,

        $3,
        'USD',
        $4,

        $5,
        $6,
        $7,
        $8,

        $9,
        $10,

        $11,
        $12,

        $13,
        $14,
        $15,
        $16,

        $17,
        $18,
        $19,

        $20::jsonb,

        'started',
        $21::jsonb
      )
    RETURNING *
    `,
    [
      userId,
      toPhoneE164,

      rate.id,
      oneMinuteCostCents,

      providerCode,
      rate.provider_id,
      rate.provider_plan_id,
      rate.provider_rate_id,

      rate.route_id,
      rate.route_provider_id,

      rate.provider_plan_code,
      rate.provider_discount_percent,

      rate.raw_provider_rate_usd_per_min,
      rate.platform_fee_usd_per_min,
      rate.discounted_provider_rate_usd_per_min,
      rate.total_provider_cost_usd_per_min,

      sellRate,
      rate.markup_percent,
      rate.min_profit_usd_per_min,

      JSON.stringify(
        rate.route_attempts || []
      ),

      JSON.stringify(sessionMeta),
    ]
  );

  return {
    ok: true,
    session: rows[0],

    routing: {
      source: rate.rate_source,

      provider: {
        id: rate.provider_id,
        code: providerCode,
      },

      provider_plan: {
        id: rate.provider_plan_id,
        code: rate.provider_plan_code,
      },

      route: {
        id: rate.route_id,
        route_provider_id:
          rate.route_provider_id,
      },

      matched_prefix: rate.prefix,

      sell_rate_usd_per_min:
        sellRate,

      total_provider_cost_usd_per_min:
        rate.total_provider_cost_usd_per_min,
    },
  };
}

/**
 * User end request এখন provider webhook billing-এর ওপর নির্ভরশীল।
 */
async function endCallAndCharge({
  userId,
  sessionId,
}) {
  return {
    ok: true,
    reason:
      "billing_by_provider_webhook_only",
  };
}

/**
 * Provider webhook/CDR-এর final duration দিয়ে completed call bill করে।
 */
async function billCompletedCallByProvider({
  callSid,
  sessionId,
  rawPayload,
}) {
  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    const sessionResult = await client.query(
      `
      SELECT *
      FROM call_sessions
      WHERE
        provider_call_id = $1
        OR id = $2
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
      `,
      [
        callSid || null,
        Number(sessionId || 0),
      ]
    );

    const session =
      sessionResult.rows[0];

    if (!session) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason: "session_not_found",
      };
    }

    if (
      session.status === "charged" ||
      Number(
        session.charged_amount_cents || 0
      ) > 0
    ) {
      await client.query("COMMIT");

      return {
        ok: true,
        reason: "already_charged",
      };
    }

    if (!session.answered_at) {
      await client.query(
        `
        UPDATE call_sessions
        SET
          status = 'completed',
          provider_status = 'completed',
          ended_at = COALESCE(ended_at, NOW()),
          duration_sec = 0,
          charged_minutes = 0,
          charged_amount_cents = 0,
          billing_source =
            'answered_at_missing_no_charge',
          status_callback_payload = $2
        WHERE id = $1
        `,
        [
          session.id,
          rawPayload || {},
        ]
      );

      await client.query("COMMIT");

      return {
        ok: true,
        reason:
          "no_charge_not_answered",
      };
    }

    const durationSec = Number(
      rawPayload?.CallDuration ??
        rawPayload?.Duration ??
        rawPayload?.duration_sec ??
        rawPayload?.billable_duration_sec ??
        0
    );

    const safeDurationSec = Math.max(
      0,
      Math.floor(
        Number.isFinite(durationSec)
          ? durationSec
          : 0
      )
    );

    if (safeDurationSec <= 0) {
      await client.query(
        `
        UPDATE call_sessions
        SET
          status = 'completed',
          provider_status = 'completed',
          ended_at = COALESCE(ended_at, NOW()),
          duration_sec = 0,
          charged_minutes = 0,
          charged_amount_cents = 0,
          billing_source =
            'zero_answered_duration',
          status_callback_payload = $2
        WHERE id = $1
        `,
        [
          session.id,
          rawPayload || {},
        ]
      );

      await client.query("COMMIT");

      return {
        ok: true,
        reason:
          "no_charge_zero_duration",
      };
    }

    const chargedMinutes =
      ceilMinutes(safeDurationSec);

    const pricePerMinCents = Math.max(
      1,
      Number(
        session.price_per_min_cents ||
          toUsdCents(
            session.sell_rate_usd_per_min
          )
      )
    );

    const amountCents =
      chargedMinutes * pricePerMinCents;

    const sellRate =
      pricePerMinCents / 100;

    /*
     * Multi-provider session হলে actual cost:
     * discounted termination rate + platform fee.
     *
     * Historical session হলে পুরোনো provider_rate field fallback।
     */
    const providerCostRate = Number(
      session.total_provider_cost_usd_per_min ||
        session.provider_rate_usd_per_min ||
        0
    );

    const chargedUsd = round7(
      amountCents / 100
    );

    const providerCostUsd = round7(
      chargedMinutes * providerCostRate
    );

    const profitUsd = round7(
      chargedUsd - providerCostUsd
    );

    const providerCostCents = Math.max(
      0,
      Math.round(providerCostUsd * 100)
    );

    const profitCents =
      amountCents - providerCostCents;

    /*
     * Session lock transaction এখানে শেষ করা হয়।
     * Wallet service নিজস্ব transaction/idempotency ব্যবহার করে।
     */
    await client.query("COMMIT");

    const debit =
      await walletService.applyWalletTx({
        userId: session.user_id,
        currency: "USD",
        amountCents,
        txType: "call_charge",

        meta: {
          session_id: session.id,
          to_phone_e164:
            session.to_phone_e164,

          provider:
            session.provider,

          provider_id:
            session.provider_id,

          provider_plan_id:
            session.provider_plan_id,

          provider_rate_id:
            session.provider_rate_id,

          route_id:
            session.route_id,

          route_provider_id:
            session.route_provider_id,

          duration_sec:
            safeDurationSec,

          charged_minutes:
            chargedMinutes,

          sell_rate_usd_per_min:
            sellRate,

          provider_cost_rate_usd_per_min:
            providerCostRate,

          charged_usd:
            chargedUsd,

          provider_cost_usd:
            providerCostUsd,

          profit_usd:
            profitUsd,

          provider_call_id:
            callSid,
        },

        idempotencyKey:
          `call_charge:${session.id}`,
      });

    if (!debit.ok) {
      await db.query(
        `
        UPDATE call_sessions
        SET
          status = 'failed',
          provider_status = 'completed',
          ended_at =
            COALESCE(ended_at, NOW()),
          duration_sec = $2,
          charged_minutes = $3,
          charged_amount_cents = $4,
          billing_source =
            'wallet_debit_failed',
          status_callback_payload = $5
        WHERE id = $1
        `,
        [
          session.id,
          safeDurationSec,
          chargedMinutes,
          amountCents,
          rawPayload || {},
        ]
      );

      return {
        ok: false,
        reason:
          debit.reason ||
          "wallet_debit_failed",
      };
    }

    await db.query(
      `
      UPDATE call_sessions
      SET
        status = 'charged',
        provider_status = 'completed',
        ended_at =
          COALESCE(ended_at, NOW()),
        duration_sec = $2,
        charged_minutes = $3,
        charged_amount_cents = $4,
        tx_id = $5,

        provider_cost_cents = $6,
        profit_cents = $7,

        provider_cost_usd = $8,
        charged_amount_usd = $9,
        profit_usd = $10,

        billing_source =
          'provider_webhook_duration',

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

      provider:
        session.provider,

      duration_sec:
        safeDurationSec,

      charged_minutes:
        chargedMinutes,

      charged_amount_cents:
        amountCents,

      provider_cost_usd:
        providerCostUsd,

      profit_usd:
        profitUsd,

      wallet:
        debit.wallet,

      tx:
        debit.tx,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Original error preserve করা হচ্ছে।
    }

    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  startCallSession,
  endCallAndCharge,
  billCompletedCallByProvider,
  findRateByToPhone,
};