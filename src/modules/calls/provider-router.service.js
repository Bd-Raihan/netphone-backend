const repository = require("./provider-router.repository");

const DEFAULT_MARKUP_PERCENT = 25;
const DEFAULT_MIN_PROFIT_USD_PER_MIN = 0.002;

function round6(value) {
  return Number(Number(value || 0).toFixed(6));
}

function normalizePositiveNumber(value, fallback = 0) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }

  return number;
}

function calculatePricing({
  rawProviderRate,
  discountPercent = 0,
  platformFeeUsdPerMin = 0,
  markupPercent = DEFAULT_MARKUP_PERCENT,
  minimumProfitUsdPerMin = DEFAULT_MIN_PROFIT_USD_PER_MIN,
}) {
  const rawRate = normalizePositiveNumber(rawProviderRate);
  const safeDiscount = Math.min(
    100,
    normalizePositiveNumber(discountPercent)
  );
  const platformFee = normalizePositiveNumber(platformFeeUsdPerMin);
  const markup = normalizePositiveNumber(
    markupPercent,
    DEFAULT_MARKUP_PERCENT
  );
  const minimumProfit = normalizePositiveNumber(
    minimumProfitUsdPerMin,
    DEFAULT_MIN_PROFIT_USD_PER_MIN
  );

  const discountedProviderRate =
    rawRate * (1 - safeDiscount / 100);

  const totalProviderCost =
    discountedProviderRate + platformFee;

  const sellRateByMarkup =
    totalProviderCost * (1 + markup / 100);

  const sellRateByMinimumProfit =
    totalProviderCost + minimumProfit;

  const sellRate = Math.max(
    sellRateByMarkup,
    sellRateByMinimumProfit
  );

  return {
    raw_provider_rate_usd_per_min: round6(rawRate),
    discount_percent: round6(safeDiscount),
    discounted_provider_rate_usd_per_min: round6(
      discountedProviderRate
    ),
    platform_fee_usd_per_min: round6(platformFee),
    total_provider_cost_usd_per_min: round6(
      totalProviderCost
    ),
    markup_percent: round6(markup),
    min_profit_usd_per_min: round6(minimumProfit),
    sell_rate_usd_per_min: round6(sellRate),
    expected_profit_usd_per_min: round6(
      sellRate - totalProviderCost
    ),
  };
}

function getEffectiveMaximumRate({
  destinationPolicy,
  route,
  routeProvider,
}) {
  const candidates = [
    routeProvider?.max_provider_rate_usd_min,
    route?.max_provider_rate_usd_min,
    destinationPolicy?.max_provider_rate_usd_min,
  ]
    .map(Number)
    .filter(
      (value) =>
        Number.isFinite(value) &&
        value > 0
    );

  if (candidates.length === 0) {
    return null;
  }

  return Math.min(...candidates);
}

function getEffectiveMarkup({
  destinationPolicy,
  route,
}) {
  const routeMarkup = Number(route?.markup_percent);

  if (
    Number.isFinite(routeMarkup) &&
    routeMarkup >= 0
  ) {
    return routeMarkup;
  }

  const policyMarkup = Number(
    destinationPolicy?.markup_percent
  );

  if (
    Number.isFinite(policyMarkup) &&
    policyMarkup >= 0
  ) {
    return policyMarkup;
  }

  return DEFAULT_MARKUP_PERCENT;
}

function getEffectiveMinimumProfit({
  destinationPolicy,
  route,
}) {
  const routeMinimumProfit = Number(
    route?.min_profit_usd_per_min
  );

  if (
    Number.isFinite(routeMinimumProfit) &&
    routeMinimumProfit >= 0
  ) {
    return routeMinimumProfit;
  }

  const policyMinimumProfit = Number(
    destinationPolicy?.min_profit_usd_per_min
  );

  if (
    Number.isFinite(policyMinimumProfit) &&
    policyMinimumProfit >= 0
  ) {
    return policyMinimumProfit;
  }

  return DEFAULT_MIN_PROFIT_USD_PER_MIN;
}

function buildFailure(reason, extra = {}) {
  return {
    ok: false,
    reason,
    ...extra,
  };
}

/**
 * নতুন multi-provider route table ব্যবহার করে destination resolve করে।
 */
async function resolveMultiProviderRoute(toPhoneE164) {
  const destinationPolicy =
    await repository.findDestinationPolicy(toPhoneE164);

  if (
    destinationPolicy &&
    destinationPolicy.is_enabled === false
  ) {
    return buildFailure("destination_disabled", {
      destination_policy: destinationPolicy,
      disabled_reason:
        destinationPolicy.disabled_reason ||
        "Destination is disabled",
    });
  }

  const route =
    await repository.findActiveRoute(toPhoneE164);

  if (!route) {
    return buildFailure("active_route_not_found", {
      destination_policy: destinationPolicy,
    });
  }

  const candidates =
    await repository.findRouteProviderCandidates(route.id);

  if (!candidates.length) {
    return buildFailure("active_provider_not_found", {
      destination_policy: destinationPolicy,
      route,
    });
  }

  const rejectedProviders = [];

  for (const candidate of candidates) {
    const providerRate =
      await repository.findProviderRate({
        providerId: candidate.provider_id,
        rateCardId: candidate.rate_card_id,
        toPhoneE164,
      });

    if (!providerRate) {
      rejectedProviders.push({
        provider_code: candidate.provider_code,
        route_provider_id:
          candidate.route_provider_id,
        reason: "provider_rate_not_found",
      });

      if (!candidate.allow_fallback) {
        break;
      }

      continue;
    }

    const rawProviderRate = Number(
      providerRate.raw_rate_usd_per_min
    );

    if (
      !Number.isFinite(rawProviderRate) ||
      rawProviderRate <= 0
    ) {
      rejectedProviders.push({
        provider_code: candidate.provider_code,
        route_provider_id:
          candidate.route_provider_id,
        provider_rate_id:
          providerRate.provider_rate_id,
        reason: "invalid_provider_rate",
      });

      if (!candidate.allow_fallback) {
        break;
      }

      continue;
    }

    const maximumRate = getEffectiveMaximumRate({
      destinationPolicy,
      route,
      routeProvider: candidate,
    });

    if (
      maximumRate !== null &&
      rawProviderRate > maximumRate
    ) {
      rejectedProviders.push({
        provider_code: candidate.provider_code,
        route_provider_id:
          candidate.route_provider_id,
        provider_rate_id:
          providerRate.provider_rate_id,
        provider_rate_usd_per_min:
          rawProviderRate,
        max_provider_rate_usd_per_min:
          maximumRate,
        reason: "provider_rate_above_maximum",
      });

      if (!candidate.allow_fallback) {
        break;
      }

      continue;
    }

    const pricing = calculatePricing({
      rawProviderRate,
      discountPercent:
        candidate.discount_percent,
      platformFeeUsdPerMin:
        candidate.platform_fee_usd_per_min,
      markupPercent: getEffectiveMarkup({
        destinationPolicy,
        route,
      }),
      minimumProfitUsdPerMin:
        getEffectiveMinimumProfit({
          destinationPolicy,
          route,
        }),
    });

    if (
      pricing.sell_rate_usd_per_min <=
      pricing.total_provider_cost_usd_per_min
    ) {
      rejectedProviders.push({
        provider_code: candidate.provider_code,
        route_provider_id:
          candidate.route_provider_id,
        provider_rate_id:
          providerRate.provider_rate_id,
        reason: "sell_rate_not_above_cost",
      });

      if (!candidate.allow_fallback) {
        break;
      }

      continue;
    }

    return {
      ok: true,
      source: "multi_provider_router",
      destination_policy:
        destinationPolicy,
      route,
      route_provider: candidate,
      provider: {
        id: candidate.provider_id,
        code: candidate.provider_code,
        name: candidate.provider_name,
        type: candidate.provider_type,
      },
      provider_plan: {
        id: candidate.provider_plan_id,
        code: candidate.provider_plan_code,
        name: candidate.provider_plan_name,
        tier: candidate.plan_tier,
        discount_percent:
          Number(candidate.discount_percent || 0),
      },
      provider_rate: providerRate,
      pricing,
      max_provider_rate_usd_per_min:
        maximumRate,
      rejected_providers: rejectedProviders,
    };
  }

  return buildFailure("no_safe_provider_available", {
    destination_policy: destinationPolicy,
    route,
    rejected_providers: rejectedProviders,
  });
}

/**
 * পুরোনো call_rates table ব্যবহার করে backward-compatible resolution।
 *
 * Route data এখনো seed/import না হওয়া পর্যন্ত Telnyx-এর working flow
 * চালু রাখার জন্য এটি প্রয়োজন।
 */
async function resolveLegacyRate(toPhoneE164) {
  const rate =
    await repository.findLegacyCallRate(toPhoneE164);

  if (!rate) {
    return buildFailure("rate_not_found");
  }

  if (rate.publish_rate === false) {
    return buildFailure("destination_unpublished", {
      rate,
      disabled_reason: rate.disabled_reason,
    });
  }

  const providerRate = Number(
    rate.provider_rate_usd_per_min || 0
  );

  const sellRate = Number(
    rate.sell_rate_usd_per_min ||
      Number(rate.price_per_min_cents || 0) / 100
  );

  const platformFee = Number(
    rate.platform_fee_usd_per_min || 0
  );

  const discountedRate = Number(
    rate.discounted_provider_rate_usd_per_min ||
      providerRate
  );

  const totalCost =
    discountedRate + platformFee;

  if (
    !Number.isFinite(sellRate) ||
    sellRate <= 0
  ) {
    return buildFailure("invalid_sell_rate", {
      rate,
    });
  }

  if (
    Number.isFinite(totalCost) &&
    totalCost > 0 &&
    sellRate <= totalCost
  ) {
    return buildFailure("sell_rate_not_above_cost", {
      rate,
      total_provider_cost_usd_per_min:
        round6(totalCost),
    });
  }

  const maximumRate = Number(
    rate.max_provider_rate_usd_per_min
  );

  if (
    Number.isFinite(maximumRate) &&
    maximumRate > 0 &&
    providerRate > maximumRate
  ) {
    return buildFailure(
      "provider_rate_above_maximum",
      {
        rate,
        provider_rate_usd_per_min:
          providerRate,
        max_provider_rate_usd_per_min:
          maximumRate,
      }
    );
  }

  return {
    ok: true,
    source: "legacy_call_rates",
    provider: {
      id: rate.provider_id || null,
      code: rate.provider || "telnyx",
      name: rate.provider || "Telnyx",
    },
    provider_plan: {
      id: rate.provider_plan_id || null,
    },
    route: {
      id: rate.route_id || null,
    },
    route_provider: null,
    provider_rate: {
      provider_rate_id:
        rate.provider_rate_id || null,
      raw_rate_usd_per_min: providerRate,
      prefix: rate.prefix,
      country_code: rate.country_code,
      country_name: rate.country_name,
    },
    pricing: {
      raw_provider_rate_usd_per_min:
        round6(providerRate),
      discounted_provider_rate_usd_per_min:
        round6(discountedRate),
      platform_fee_usd_per_min:
        round6(platformFee),
      total_provider_cost_usd_per_min:
        round6(totalCost),
      markup_percent: Number(
        rate.markup_percent || 25
      ),
      min_profit_usd_per_min: Number(
        rate.min_profit_usd_per_min || 0
      ),
      sell_rate_usd_per_min:
        round6(sellRate),
      expected_profit_usd_per_min:
        round6(sellRate - totalCost),
    },
    call_rate: rate,
    max_provider_rate_usd_per_min:
      Number.isFinite(maximumRate) &&
      maximumRate > 0
        ? maximumRate
        : null,
    rejected_providers: [],
  };
}

/**
 * Main destination resolver.
 *
 * Priority:
 * 1. Destination disabled policy
 * 2. Multi-provider route
 * 3. Existing call_rates backward-compatible fallback
 */
async function resolveDestination(toPhoneE164) {
  const phone = repository.cleanPhone(
    toPhoneE164
  );

  if (!phone) {
    return buildFailure(
      "invalid_destination_number"
    );
  }

  const destinationPolicy =
    await repository.findDestinationPolicy(
      toPhoneE164
    );

  if (
    destinationPolicy &&
    destinationPolicy.is_enabled === false
  ) {
    return buildFailure("destination_disabled", {
      destination_policy:
        destinationPolicy,
      disabled_reason:
        destinationPolicy.disabled_reason ||
        "Destination is disabled",
    });
  }

  const multiProviderResult =
    await resolveMultiProviderRoute(
      toPhoneE164
    );

  if (multiProviderResult.ok) {
    return multiProviderResult;
  }

  const legacyResult =
    await resolveLegacyRate(toPhoneE164);

  if (legacyResult.ok) {
    return {
      ...legacyResult,
      router_fallback_reason:
        multiProviderResult.reason,
      router_rejected_providers:
        multiProviderResult.rejected_providers ||
        [],
    };
  }

  return buildFailure(
    multiProviderResult.reason ===
      "active_route_not_found"
      ? legacyResult.reason
      : multiProviderResult.reason,
    {
      destination_policy:
        destinationPolicy,
      multi_provider_result:
        multiProviderResult,
      legacy_result: legacyResult,
    }
  );
}

module.exports = {
  calculatePricing,
  resolveDestination,
  resolveMultiProviderRoute,
  resolveLegacyRate,
};