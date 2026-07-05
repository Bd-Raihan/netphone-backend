const db = require("../../config/db");

async function getProfitSummary() {
  const result = await db.query(`
    SELECT
      COUNT(*)::int AS total_calls,
      COALESCE(SUM(charged_minutes), 0)::int AS total_minutes,
      COALESCE(SUM(charged_amount_usd), 0)::numeric(12,5) AS total_revenue,
      COALESCE(SUM(provider_cost_usd), 0)::numeric(12,5) AS total_provider_cost,
      COALESCE(SUM(profit_usd), 0)::numeric(12,5) AS total_profit,
      COALESCE(
        ROUND((SUM(profit_usd) / NULLIF(SUM(charged_amount_usd), 0)) * 100, 2),
        0
      ) AS profit_percent
    FROM call_sessions
    WHERE status = 'charged'
  `);

  return result.rows[0];
}

async function getTodayProfit() {
  const result = await db.query(`
    SELECT
      COUNT(*)::int AS total_calls,
      COALESCE(SUM(charged_minutes), 0)::int AS total_minutes,
      COALESCE(SUM(charged_amount_usd), 0)::numeric(12,5) AS total_revenue,
      COALESCE(SUM(provider_cost_usd), 0)::numeric(12,5) AS total_provider_cost,
      COALESCE(SUM(profit_usd), 0)::numeric(12,5) AS total_profit,
      COALESCE(
        ROUND((SUM(profit_usd) / NULLIF(SUM(charged_amount_usd), 0)) * 100, 2),
        0
      ) AS profit_percent
    FROM call_sessions
    WHERE status = 'charged'
      AND started_at >= CURRENT_DATE
  `);

  return result.rows[0];
}

async function getCountryWiseProfit() {
  const result = await db.query(`
    SELECT
      ROW_NUMBER() OVER (ORDER BY SUM(cs.profit_usd) DESC) AS serial_no,
      cr.country_name,
      cr.country_code,
      COUNT(cs.id)::int AS total_calls,
      COALESCE(SUM(cs.charged_minutes), 0)::int AS total_minutes,
      COALESCE(SUM(cs.charged_amount_usd), 0)::numeric(12,5) AS total_user_paid,
      COALESCE(SUM(cs.provider_cost_usd), 0)::numeric(12,5) AS total_twilio_cost,
      COALESCE(SUM(cs.profit_usd), 0)::numeric(12,5) AS total_profit,
      COALESCE(
        ROUND((SUM(cs.profit_usd) / NULLIF(SUM(cs.charged_amount_usd), 0)) * 100, 2),
        0
      ) AS profit_percent
    FROM call_sessions cs
    LEFT JOIN call_rates cr ON cr.id = cs.rate_id
    WHERE cs.status = 'charged'
    GROUP BY cr.country_name, cr.country_code
    ORDER BY total_profit DESC
  `);

  return result.rows;
}

async function getUserCountryWiseProfit() {
  const result = await db.query(`
    SELECT
      ROW_NUMBER() OVER (ORDER BY SUM(cs.profit_usd) DESC) AS serial_no,
      cr.country_name,
      cr.country_code,
      u.phone_e164 AS registered_phone,
      COALESCE(u.name, 'Unknown') AS user_name,
      COUNT(cs.id)::int AS total_calls,
      COALESCE(SUM(cs.charged_minutes), 0)::int AS total_minutes,
      COALESCE(SUM(cs.charged_amount_usd), 0)::numeric(12,5) AS total_user_paid,
      COALESCE(SUM(cs.provider_cost_usd), 0)::numeric(12,5) AS total_twilio_cost,
      COALESCE(SUM(cs.profit_usd), 0)::numeric(12,5) AS total_profit,
      COALESCE(
        ROUND((SUM(cs.profit_usd) / NULLIF(SUM(cs.charged_amount_usd), 0)) * 100, 2),
        0
      ) AS profit_percent
    FROM call_sessions cs
    LEFT JOIN call_rates cr ON cr.id = cs.rate_id
    LEFT JOIN users u ON u.id = cs.user_id
    WHERE cs.status = 'charged'
    GROUP BY cr.country_name, cr.country_code, u.phone_e164, u.name
    ORDER BY total_profit DESC
  `);

  return result.rows;
}

module.exports = {
  getProfitSummary,
  getTodayProfit,
  getCountryWiseProfit,
  getUserCountryWiseProfit,
};