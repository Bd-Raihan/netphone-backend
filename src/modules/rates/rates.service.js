/**
 * ============================================================
 * NetPhone Public International Rates
 * ============================================================
 *
 * কাজ:
 * - Admin Country Pricing-এর Final Sell Rate public user-কে দেখানো
 * - Provider cost / profit / markup expose না করা
 * - Wallet-এর জন্য single-country lookup support করা
 * - Short memory cache দিয়ে repeated heavy pricing query কমানো
 * ============================================================
 */

const countryPricingService = require(
  "../admin-country-pricing/admin-country-pricing.service"
);

const PUBLIC_RATE_CACHE_TTL_MS = 60 * 1000;

let publicRatesCache = {
  data: null,
  expiresAt: 0,
};

function normalizePublicRate(row) {
  const rate = Number(
    row.final_sell_rate_usd_per_min || 0
  );

  if (
    row.is_active !== true ||
    row.publish_rate === false ||
    !Number.isFinite(rate) ||
    rate <= 0
  ) {
    return null;
  }

  return {
    country_name:
      row.country_name ||
      row.route_name ||
      row.provider_country_name ||
      "Unknown",

    country_code:
      String(
        row.country_code ||
        row.provider_country_code ||
        ""
      )
        .trim()
        .toUpperCase(),

    prefix:
      String(
        row.prefix ||
        row.provider_prefix ||
        ""
      ).replace(/\D/g, ""),

    sell_rate_usd_per_min:
      Number(rate.toFixed(7)),

    // Flutter পুরোনো model compatibility
    price_per_min_cents:
      Math.max(
        1,
        Math.ceil(rate * 100)
      ),

    updated_at:
      row.manual_rate_updated_at ||
      null,
  };
}

async function loadPublicRatesFresh() {
  const rows =
    await countryPricingService
      .listCountryPricing();

  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map(normalizePublicRate)
    .filter(Boolean)
    .sort((a, b) =>
      a.country_name.localeCompare(
        b.country_name
      )
    );
}

async function getPublicRates({
  forceRefresh = false,
} = {}) {
  const now = Date.now();

  if (
    !forceRefresh &&
    Array.isArray(
      publicRatesCache.data
    ) &&
    publicRatesCache.expiresAt > now
  ) {
    return publicRatesCache.data;
  }

  const rates =
    await loadPublicRatesFresh();

  publicRatesCache = {
    data: rates,
    expiresAt:
      Date.now() +
      PUBLIC_RATE_CACHE_TTL_MS,
  };

  return rates;
}

/**
 * Wallet এবং lightweight lookup-এর জন্য।
 *
 * একটি phone number-এর জন্য শুধু matching
 * public rate return করবে।
 */
async function getPublicRateByPhone(
  phoneE164
) {
  const normalizedPhone =
    String(phoneE164 || "")
      .replace(/\D/g, "");

  if (!normalizedPhone) {
    return null;
  }

  const rates =
    await getPublicRates();

  let bestMatch = null;
  let bestPrefixLength = -1;

  for (const rate of rates) {
    const prefix =
      String(rate?.prefix || "")
        .replace(/\D/g, "");

    if (
      !prefix ||
      !normalizedPhone.startsWith(
        prefix
      )
    ) {
      continue;
    }

    if (
      prefix.length >
      bestPrefixLength
    ) {
      bestMatch = rate;
      bestPrefixLength =
        prefix.length;
    }
  }

  return bestMatch;
}

function clearPublicRatesCache() {
  publicRatesCache = {
    data: null,
    expiresAt: 0,
  };
}

module.exports = {
  getPublicRates,
  getPublicRateByPhone,
  clearPublicRatesCache,
};