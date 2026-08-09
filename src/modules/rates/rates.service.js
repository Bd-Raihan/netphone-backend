/**
 * ============================================================
 * NetPhone Public International Rates
 * ============================================================
 *
 * কাজ:
 * - Telnyx provider pricing engine থেকে current country pricing নেওয়া
 * - Admin Country Pricing-এর Final Sell Rate public user-কে দেখানো
 * - Provider cost / profit / markup expose না করা
 *
 * Public fields:
 * - Country Name
 * - Mobile Prefix
 * - Per-Minute Sell Rate
 * ============================================================
 */

const countryPricingService = require(
  "../admin-country-pricing/admin-country-pricing.service"
);

async function getPublicRates() {
  const rows =
    await countryPricingService.listCountryPricing();

  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .filter((row) => {
      const rate = Number(
        row.final_sell_rate_usd_per_min || 0
      );

      return (
        row.is_active === true &&
        row.publish_rate !== false &&
        Number.isFinite(rate) &&
        rate > 0
      );
    })
    .map((row) => {
      const rate = Number(
        row.final_sell_rate_usd_per_min
      );

      return {
        country_name:
          row.country_name ||
          row.route_name ||
          row.provider_country_name ||
          "Unknown",

        country_code:
          row.country_code ||
          row.provider_country_code ||
          "",

        prefix:
          String(
            row.prefix ||
            row.provider_prefix ||
            ""
          ).replace(/^\+/, ""),

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
    })
    .sort((a, b) => {
      return a.country_name.localeCompare(
        b.country_name
      );
    });
}

module.exports = {
  getPublicRates,
};