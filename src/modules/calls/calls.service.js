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
 * Safe non-negative decimal parser.
 */
function toNonNegativeNumber(value, fallback = 0) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

/**
 * Safe positive integer parser.
 *
 * Telnyx CSV billing increment invalid বা missing হলে
 * fallback value ব্যবহার করবে।
 */
function toPositiveInteger(value, fallback = 60) {
  const parsed = Number.parseInt(
    String(value ?? ""),
    10
  );

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

/**
 * USD total amount-কে wallet cents-এ convert করে।
 *
 * Important:
 * Per-minute rate আগে cents-এ convert করা হবে না।
 * পুরো call-এর decimal total হিসাব হওয়ার পরে একবারে
 * wallet cents-এ convert হবে।
 */
function usdTotalToWalletCents(usdAmount) {
  const safeAmount =
    toNonNegativeNumber(usdAmount, 0);

  if (safeAmount <= 0) {
    return 0;
  }

  return Math.max(
    1,
    Math.ceil(
      (safeAmount * 100) - Number.EPSILON
    )
  );
}

const MICRO_USD_PER_USD = 1_000_000;

function usdTotalToMicroUsd(usdAmount) {
  const safeAmount =
    toNonNegativeNumber(
      usdAmount,
      0
    );

  if (safeAmount <= 0) {
    return 0;
  }

  /*
   * Call amount সর্বোচ্চ 7 decimal snapshot থেকে আসে।
   * Wallet ledger 6 decimal পর্যন্ত exact রাখবে।
   */
  return Math.max(
    1,
    Math.round(
      safeAmount *
      MICRO_USD_PER_USD
    )
  );
}

/**
 * Telnyx/provider billing policy অনুযায়ী billable seconds হিসাব করে।
 *
 * Formula:
 * 1. actual duration এবং minimum duration-এর বড় value নেওয়া
 * 2. billing increment অনুযায়ী উপরের দিকে round করা
 */
function calculateBillableSeconds({
  actualDurationSeconds,
  minimumDurationSeconds,
  billingIncrementSeconds,
}) {
  const actualSeconds = Math.max(
    0,
    Math.floor(
      toNonNegativeNumber(
        actualDurationSeconds,
        0
      )
    )
  );

  if (actualSeconds <= 0) {
    return 0;
  }

  const minimumSeconds = Math.max(
    0,
    Math.floor(
      toNonNegativeNumber(
        minimumDurationSeconds,
        0
      )
    )
  );

  const incrementSeconds =
    toPositiveInteger(
      billingIncrementSeconds,
      60
    );

  const minimumAppliedSeconds = Math.max(
    actualSeconds,
    minimumSeconds
  );

  return (
    Math.ceil(
      minimumAppliedSeconds /
        incrementSeconds
    ) * incrementSeconds
  );
}

/**
 * Provider webhook payload থেকে duration বের করে।
 *
 * Telnyx event-এ duration না থাকলে answered_at এবং ended_at
 * timestamp-এর পার্থক্য ব্যবহার করা হবে।
 */
function resolveActualDurationSeconds({
  rawPayload,
  answeredAt,
  endedAt,
}) {
  const payload = rawPayload || {};

  const durationCandidates = [
    payload.CallDuration,
    payload.Duration,
    payload.duration_sec,
    payload.duration_secs,
    payload.duration_seconds,
    payload.billable_duration_sec,
    payload.billable_duration_secs,
    payload.billable_seconds,
  ];

  for (const candidate of durationCandidates) {
    const parsed = Number(candidate);

    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(
        1,
        Math.floor(parsed)
      );
    }
  }

  const answeredTimestamp =
    answeredAt
      ? new Date(answeredAt).getTime()
      : Number.NaN;

  const endedTimestamp =
    endedAt
      ? new Date(endedAt).getTime()
      : Date.now();

  if (
    Number.isFinite(answeredTimestamp) &&
    Number.isFinite(endedTimestamp) &&
    endedTimestamp > answeredTimestamp
  ) {
    return Math.max(
      1,
      Math.floor(
        (endedTimestamp - answeredTimestamp) /
          1000
      )
    );
  }

  return 0;
}

/**
 * Call session-এর immutable pricing snapshot safely read করে।
 */
function readPricingSnapshot(session) {
  const meta =
    session?.meta &&
    typeof session.meta === "object"
      ? session.meta
      : {};

  const snapshot =
    meta.pricing_snapshot &&
    typeof meta.pricing_snapshot === "object"
      ? meta.pricing_snapshot
      : {};

  return snapshot;
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
    const providerConnectionFeeUsd =
    toNonNegativeNumber(
      pricing.provider_connection_fee_usd ??
        pricing.connection_fee_usd ??
        providerRate.connection_fee_usd ??
        callRate?.provider_connection_fee_usd ??
        callRate?.connection_fee_usd ??
        0,
      0
    );

  /*
   * বর্তমানে customer connection fee provider fee-এর সমান।
   * পরবর্তী Admin API-তে আলাদা manual customer fee দেওয়া যাবে।
   */
  const customerConnectionFeeUsd =
    toNonNegativeNumber(
      pricing.customer_connection_fee_usd ??
        callRate?.customer_connection_fee_usd ??
        providerConnectionFeeUsd,
      providerConnectionFeeUsd
    );

  const billingIncrementSeconds =
    toPositiveInteger(
      pricing.billing_increment_seconds ??
        providerRate.billing_increment_seconds ??
        callRate?.billing_increment_seconds ??
        60,
      60
    );

  const minimumDurationSeconds = Math.max(
    0,
    Math.floor(
      toNonNegativeNumber(
        pricing.minimum_duration_seconds ??
          providerRate.minimum_duration_seconds ??
          callRate?.minimum_duration_seconds ??
          60,
        60
      )
    )
  );

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

    provider_connection_fee_usd:
      round7(providerConnectionFeeUsd),

    customer_connection_fee_usd:
      round7(customerConnectionFeeUsd),

    billing_increment_seconds:
      billingIncrementSeconds,

    minimum_duration_seconds:
      minimumDurationSeconds,

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

     /*
     * এটি শুধু backward-compatible display/snapshot field।
     * Final billing এই cents value দিয়ে হবে না।
     */
    price_per_min_cents: Math.max(
      1,
      Math.ceil(
        (sellRate * 100) -
          Number.EPSILON
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

  /*
   * Call শুরু করার minimum required balance:
   *
   * Telnyx minimum duration
   * + billing increment
   * + customer connection fee
   *
   * এটি শুধু call eligibility check।
   * Final charge provider webhook-এর actual duration দিয়ে হবে।
   */
  const minimumBillableSeconds =
    calculateBillableSeconds({
      actualDurationSeconds: 1,

      minimumDurationSeconds:
        rate.minimum_duration_seconds,

      billingIncrementSeconds:
        rate.billing_increment_seconds,
    });

  const minimumUsageChargeUsd =
    sellRate *
    (minimumBillableSeconds / 60);

  const minimumCallChargeUsd = round7(
    minimumUsageChargeUsd +
      toNonNegativeNumber(
        rate.customer_connection_fee_usd,
        0
      )
  );

  const minimumCallChargeCents =
    usdTotalToWalletCents(
      minimumCallChargeUsd
    );

  if (
    Number(wallet.balance_cents || 0) <
    minimumCallChargeCents
  ) {
    return {
      ok: false,

      reason:
        "insufficient_balance_for_call",

      message:
        "Insufficient wallet balance for the minimum call charge",

      required_balance_cents:
        minimumCallChargeCents,

      available_balance_cents:
        Number(
          wallet.balance_cents || 0
        ),

      minimum_billable_seconds:
        minimumBillableSeconds,
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

      provider_connection_fee_usd:
        rate.provider_connection_fee_usd,

      customer_connection_fee_usd:
        rate.customer_connection_fee_usd,

      billing_increment_seconds:
        rate.billing_increment_seconds,

      minimum_duration_seconds:
        rate.minimum_duration_seconds,

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
      minimumCallChargeCents,

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

      billing: {
        billing_increment_seconds:
          rate.billing_increment_seconds,

        minimum_duration_seconds:
          rate.minimum_duration_seconds,

        provider_connection_fee_usd:
          rate.provider_connection_fee_usd,

        customer_connection_fee_usd:
          rate.customer_connection_fee_usd,

        minimum_call_charge_cents:
          minimumCallChargeCents,
      },
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
 *
 * Billing source:
 * - Telnyx/provider webhook duration
 * - অথবা answered_at → ended_at fallback
 *
 * Pricing source:
 * - Call শুরুর সময় সংরক্ষিত immutable pricing snapshot
 * - historical session হলে existing database columns fallback
 */
async function billCompletedCallByProvider({
  callSid,
  sessionId,
  rawPayload,
}) {
  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    const normalizedSessionId =
      Number(sessionId || 0);

    const normalizedCallSid =
      String(callSid || "").trim() || null;

    const sessionResult =
      await client.query(
        `
        SELECT *
        FROM call_sessions
        WHERE
          (
            $1::text IS NOT NULL
            AND provider_call_id = $1::text
          )
          OR
          (
            $2::bigint > 0
            AND id = $2::bigint
          )
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE
        `,
        [
          normalizedCallSid,
          normalizedSessionId,
        ]
      );

    const session =
      sessionResult.rows[0] || null;

    if (!session) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason: "session_not_found",
      };
    }

    /*
     * Idempotency:
     * repeated Telnyx webhook একই call পুনরায় charge করবে না।
     */
    if (
      session.status === "charged" ||
      session.tx_id != null
    ) {
      await client.query("COMMIT");

      return {
        ok: true,
        reason: "already_charged",

        charged_amount_cents:
          Number(
            session.charged_amount_cents || 0
          ),
      };
    }

    if (!session.answered_at) {
      await client.query(
        `
        UPDATE call_sessions
        SET
          status = 'completed',
          provider_status = 'completed',

          ended_at =
            COALESCE(
              ended_at,
              NOW()
            ),

          duration_sec = 0,
          charged_minutes = 0,
          charged_amount_cents = 0,

          provider_cost_usd = 0,
          charged_amount_usd = 0,
          profit_usd = 0,

          billing_source =
            'answered_at_missing_no_charge',

          status_callback_payload =
            $2::jsonb,

          meta =
            COALESCE(
              meta,
              '{}'::jsonb
            ) ||
            jsonb_build_object(
              'billing_result',
              jsonb_build_object(
                'charged',
                false,

                'reason',
                'answered_at_missing'
              )
            )

        WHERE id = $1::bigint
        `,
        [
          session.id,
          JSON.stringify(
            rawPayload || {}
          ),
        ]
      );

      await client.query("COMMIT");

      return {
        ok: true,
        reason:
          "no_charge_not_answered",

        charged_amount_cents: 0,
      };
    }

    const actualDurationSeconds =
      resolveActualDurationSeconds({
        rawPayload,

        answeredAt:
          session.answered_at,

        endedAt:
          session.ended_at,
      });

    if (actualDurationSeconds <= 0) {
      await client.query(
        `
        UPDATE call_sessions
        SET
          status = 'completed',
          provider_status = 'completed',

          ended_at =
            COALESCE(
              ended_at,
              NOW()
            ),

          duration_sec = 0,
          charged_minutes = 0,
          charged_amount_cents = 0,

          provider_cost_usd = 0,
          charged_amount_usd = 0,
          profit_usd = 0,

          billing_source =
            'zero_answered_duration',

          status_callback_payload =
            $2::jsonb

        WHERE id = $1::bigint
        `,
        [
          session.id,
          JSON.stringify(
            rawPayload || {}
          ),
        ]
      );

      await client.query("COMMIT");

      return {
        ok: true,

        reason:
          "no_charge_zero_duration",

        charged_amount_cents: 0,
      };
    }

    const pricingSnapshot =
      readPricingSnapshot(session);

    const sellRateUsdPerMinute =
      toNonNegativeNumber(
        pricingSnapshot
          .sell_rate_usd_per_min ??
          session.sell_rate_usd_per_min ??
          (
            Number(
              session.price_per_min_cents || 0
            ) / 100
          ),
        0
      );

    const providerCostRateUsdPerMinute =
      toNonNegativeNumber(
        pricingSnapshot
          .total_provider_cost_usd_per_min ??
          session
            .total_provider_cost_usd_per_min ??
          session.provider_rate_usd_per_min ??
          0,
        0
      );

    const providerConnectionFeeUsd =
      toNonNegativeNumber(
        pricingSnapshot
          .provider_connection_fee_usd ??
          0,
        0
      );

    const customerConnectionFeeUsd =
      toNonNegativeNumber(
        pricingSnapshot
          .customer_connection_fee_usd ??
          providerConnectionFeeUsd,
        providerConnectionFeeUsd
      );

    const billingIncrementSeconds =
      toPositiveInteger(
        pricingSnapshot
          .billing_increment_seconds ??
          60,
        60
      );

    const minimumDurationSeconds =
      Math.max(
        0,
        Math.floor(
          toNonNegativeNumber(
            pricingSnapshot
              .minimum_duration_seconds ??
              60,
            60
          )
        )
      );

    if (sellRateUsdPerMinute <= 0) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason: "invalid_session_sell_rate",
      };
    }

    /*
     * Telnyx CSV/native provider billing interval।
     */
    const billableSeconds =
      calculateBillableSeconds({
        actualDurationSeconds,

        minimumDurationSeconds,

        billingIncrementSeconds,
      });

    if (billableSeconds <= 0) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason:
          "invalid_billable_duration",
      };
    }

    const customerUsageChargeUsd =
      round7(
        sellRateUsdPerMinute *
          (billableSeconds / 60)
      );

    const chargedUsd = round7(
      customerUsageChargeUsd +
        customerConnectionFeeUsd
    );

    const providerUsageCostUsd =
      round7(
        providerCostRateUsdPerMinute *
          (billableSeconds / 60)
      );

    const providerCostUsd = round7(
      providerUsageCostUsd +
        providerConnectionFeeUsd
    );

    const profitUsd = round7(
      chargedUsd - providerCostUsd
    );

    /*
     * Loss protection:
     * কোনো ভুল rate/snapshot-এর কারণে provider cost-এর নিচে
     * customer charge হলে call charge finalize করা হবে না।
     */
    if (
      providerCostUsd > 0 &&
      chargedUsd < providerCostUsd
    ) {
      await client.query(
        `
        UPDATE call_sessions
        SET
          status = 'failed',
          provider_status = 'completed',

          ended_at =
            COALESCE(
              ended_at,
              NOW()
            ),

          duration_sec = $2,

          billing_source =
            'billing_loss_protection',

          status_callback_payload =
            $3::jsonb,

          meta =
            COALESCE(
              meta,
              '{}'::jsonb
            ) ||
            jsonb_build_object(
              'billing_error',
              jsonb_build_object(
                'reason',
                'customer_charge_below_provider_cost',

                'charged_usd',
                $4::numeric,

                'provider_cost_usd',
                $5::numeric
              )
            )

        WHERE id = $1::bigint
        `,
        [
          session.id,
          actualDurationSeconds,

          JSON.stringify(
            rawPayload || {}
          ),

          chargedUsd,
          providerCostUsd,
        ]
      );

      await client.query("COMMIT");

      return {
        ok: false,

        reason:
          "customer_charge_below_provider_cost",
      };
    }
    const amountMicroUsd =
      usdTotalToMicroUsd(chargedUsd);
    const amountCents =
      usdTotalToWalletCents(chargedUsd);

    const providerCostCents =
      Math.max(
        0,
        Math.round(
          providerCostUsd * 100
        )
      );

    const profitCents =
      amountCents -
      providerCostCents;

    /*
     * charged_minutes integer column backward compatibility-এর জন্য।
     * সঠিক native charge হলো billable_seconds।
     */
    const chargedMinutes =
      Math.max(
        1,
        Math.ceil(
          billableSeconds / 60
        )
      );

    /*
     * Session row lock release করা হচ্ছে।
     * Wallet service-এর নিজস্ব transaction এবং idempotency আছে।
     */
    await client.query("COMMIT");

    const debit =
      await walletService.applyWalletTx({
        userId:
          session.user_id,

        currency:
          "USD",
        amountMicroUsd,
        amountCents,

        txType:
          "call_charge",

        meta: {
          session_id:
            session.id,

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

          provider_call_id:
            normalizedCallSid ||
            session.provider_call_id,

          actual_duration_seconds:
            actualDurationSeconds,

          billable_seconds:
            billableSeconds,

          charged_minutes:
            chargedMinutes,

          billing_increment_seconds:
            billingIncrementSeconds,

          minimum_duration_seconds:
            minimumDurationSeconds,

          sell_rate_usd_per_min:
            sellRateUsdPerMinute,

          provider_cost_rate_usd_per_min:
            providerCostRateUsdPerMinute,

          customer_usage_charge_usd:
            customerUsageChargeUsd,

          customer_connection_fee_usd:
            customerConnectionFeeUsd,

          provider_usage_cost_usd:
            providerUsageCostUsd,

          provider_connection_fee_usd:
            providerConnectionFeeUsd,

          charged_usd:
            chargedUsd,

          provider_cost_usd:
            providerCostUsd,

          profit_usd:
            profitUsd,
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
            COALESCE(
              ended_at,
              NOW()
            ),

          duration_sec = $2,
          charged_minutes = $3,
          charged_amount_cents = $4,

          provider_cost_cents = $5,
          profit_cents = $6,

          provider_cost_usd = $7,
          charged_amount_usd = $8,
          profit_usd = $9,

          billing_source =
            'wallet_debit_failed',

          status_callback_payload =
            $10::jsonb,

          meta =
            COALESCE(
              meta,
              '{}'::jsonb
            ) ||
            jsonb_build_object(
              'billing_result',
              jsonb_build_object(
                'charged',
                false,

                'reason',
                $11::text,

                'actual_duration_seconds',
                $2::integer,

                'billable_seconds',
                $12::integer
              )
            )

        WHERE id = $1::bigint
        `,
        [
          session.id,
          actualDurationSeconds,
          chargedMinutes,
          amountCents,

          providerCostCents,
          profitCents,

          providerCostUsd,
          chargedUsd,
          profitUsd,

          JSON.stringify(
            rawPayload || {}
          ),

          debit.reason ||
            "wallet_debit_failed",

          billableSeconds,
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
          COALESCE(
            ended_at,
            NOW()
          ),

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
          'provider_webhook_dynamic_interval',

        status_callback_payload =
          $11::jsonb,

        meta =
          COALESCE(
            meta,
            '{}'::jsonb
          ) ||
          jsonb_build_object(
            'billing_result',
            jsonb_build_object(
              'charged',
              true,

              'actual_duration_seconds',
              $2::integer,

              'billable_seconds',
              $12::integer,

              'billing_increment_seconds',
              $13::integer,

              'minimum_duration_seconds',
              $14::integer,

              'sell_rate_usd_per_min',
              $15::numeric,

              'customer_connection_fee_usd',
              $16::numeric,

              'provider_cost_rate_usd_per_min',
              $17::numeric,

              'provider_connection_fee_usd',
              $18::numeric,

              'charged_usd',
              $9::numeric,

              'provider_cost_usd',
              $8::numeric,

              'profit_usd',
              $10::numeric
            )
          )

      WHERE id = $1::bigint
      `,
      [
        session.id,
        actualDurationSeconds,
        chargedMinutes,
        amountCents,

        debit.tx?.id || null,

        providerCostCents,
        profitCents,

        providerCostUsd,
        chargedUsd,
        profitUsd,

        JSON.stringify(
          rawPayload || {}
        ),

        billableSeconds,
        billingIncrementSeconds,
        minimumDurationSeconds,

        sellRateUsdPerMinute,
        customerConnectionFeeUsd,

        providerCostRateUsdPerMinute,
        providerConnectionFeeUsd,
      ]
    );

    return {
      ok: true,

      provider:
        session.provider,

      duration_sec:
        actualDurationSeconds,

      billable_seconds:
        billableSeconds,

      charged_minutes:
        chargedMinutes,

      billing_increment_seconds:
        billingIncrementSeconds,

      minimum_duration_seconds:
        minimumDurationSeconds,

      sell_rate_usd_per_min:
        sellRateUsdPerMinute,

      charged_amount_cents:
        amountCents,

       charged_amount_microusd:
        amountMicroUsd,

      charged_amount_usd:
        chargedUsd,

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