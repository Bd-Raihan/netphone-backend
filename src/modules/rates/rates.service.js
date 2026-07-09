const db = require("../../config/db");

async function getPublicRates() {
  const result = await db.query(`
    SELECT
      country_name,
      country_code,
      prefix,
      sell_rate_usd_per_min,
      price_per_min_cents,
      updated_at
    FROM call_rates
    WHERE is_active = true
    ORDER BY country_name ASC
  `);

  return result.rows;
}

module.exports = { getPublicRates };