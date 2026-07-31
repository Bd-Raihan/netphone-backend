const db = require("../../config/db");

const averageSellRateSql = `
  COALESCE(
    ROUND(
      SUM(
        COALESCE(
          sell_rate_usd_per_min,
          CASE
            WHEN charged_minutes > 0
            THEN charged_amount_usd / charged_minutes
            ELSE 0
          END
        ) * charged_minutes
      ) / NULLIF(SUM(charged_minutes), 0),
      7
    ),
    0
  )
`;

async function getProfitSummary({ todayOnly = false } = {}) {
  const dateFilter = todayOnly
    ? "AND COALESCE(answered_at, started_at) >= CURRENT_DATE"
    : "";

  const result = await db.query(`
    SELECT
      COUNT(*)::int AS total_calls,
      COALESCE(SUM(charged_minutes), 0)::int AS total_minutes,
      COALESCE(SUM(charged_amount_usd), 0)::numeric(14,7) AS total_charge,
      COALESCE(SUM(provider_cost_usd), 0)::numeric(14,7) AS total_provider_cost,
      COALESCE(SUM(profit_usd), 0)::numeric(14,7) AS total_net_profit,
      ${averageSellRateSql} AS avg_sell_rate_usd_per_min,
      COALESCE(
        ROUND(
          SUM(profit_usd) / NULLIF(SUM(charged_amount_usd), 0) * 100,
          2
        ),
        0
      ) AS profit_percent,
      COUNT(DISTINCT COALESCE(
        NULLIF(meta #>> '{pricing_snapshot,country_name}', ''),
        to_phone_e164
      ))::int AS destination_groups
    FROM call_sessions
    WHERE status = 'charged'
      ${dateFilter}
  `);

  return result.rows[0];
}

async function getCallWiseProfitDetails() {
  const result = await db.query(`
    SELECT
      cs.id AS call_id,
      COALESCE(
        NULLIF(vpr.country_name, ''),
        NULLIF(cr.country_name, ''),
        NULLIF(cs.meta #>> '{pricing_snapshot,country_name}', ''),
        'Unknown'
      ) AS country_name,
      COALESCE(vpr.country_code, cr.country_code) AS country_code,
      cs.to_phone_e164 AS mobile_number,
      COALESCE(cs.answered_at, cs.started_at) AS called_at,
      COALESCE(cs.charged_minutes, 0)::int AS minutes,
      COALESCE(
        cs.sell_rate_usd_per_min,
        CASE
          WHEN cs.charged_minutes > 0
          THEN cs.charged_amount_usd / cs.charged_minutes
          ELSE 0
        END,
        0
      )::numeric(14,7) AS pm_rate,
      COALESCE(cs.charged_amount_usd, 0)::numeric(14,7) AS total_charge,
      COALESCE(cs.provider_cost_usd, 0)::numeric(14,7) AS provider_cost,
      COALESCE(cs.profit_usd, 0)::numeric(14,7) AS net_profit,
      COALESCE(
        ROUND(
          cs.profit_usd / NULLIF(cs.charged_amount_usd, 0) * 100,
          2
        ),
        0
      ) AS profit_percent,
      COALESCE(vp.code, cs.provider, 'unknown') AS provider
    FROM call_sessions cs
    LEFT JOIN voice_provider_rates vpr
      ON vpr.id = cs.provider_rate_id
    LEFT JOIN call_rates cr
      ON cr.id = cs.rate_id
    LEFT JOIN voice_providers vp
      ON vp.id = cs.provider_id
    WHERE cs.status = 'charged'
    ORDER BY COALESCE(cs.answered_at, cs.started_at) DESC, cs.id DESC
  `);

  return result.rows;
}

async function getCallCountrySummary() {
  const result = await db.query(`
    SELECT
      COALESCE(
        NULLIF(vpr.country_name, ''),
        NULLIF(cr.country_name, ''),
        NULLIF(cs.meta #>> '{pricing_snapshot,country_name}', ''),
        'Unknown'
      ) AS country_name,
      COUNT(*)::int AS total_calls,
      COALESCE(SUM(cs.charged_minutes), 0)::int AS total_minutes,
      COALESCE(SUM(cs.charged_amount_usd), 0)::numeric(14,7) AS total_charge,
      COALESCE(SUM(cs.provider_cost_usd), 0)::numeric(14,7) AS total_provider_cost,
      COALESCE(SUM(cs.profit_usd), 0)::numeric(14,7) AS total_net_profit
    FROM call_sessions cs
    LEFT JOIN voice_provider_rates vpr
      ON vpr.id = cs.provider_rate_id
    LEFT JOIN call_rates cr
      ON cr.id = cs.rate_id
    WHERE cs.status = 'charged'
    GROUP BY 1
    ORDER BY total_net_profit DESC, country_name ASC
  `);

  return result.rows;
}

async function getRegisteredUserSummary() {
  const result = await db.query(`
    SELECT
      COUNT(*)::int AS total_registered_numbers,
      COUNT(DISTINCT COALESCE(NULLIF(country_code, ''), 'Unknown'))::int
        AS unique_registration_countries,
      COUNT(*) FILTER (
        WHERE status = 'active'
          AND last_login_at >= NOW() - INTERVAL '30 days'
      )::int AS active_users,
      COUNT(*) FILTER (
        WHERE status = 'active'
          AND (last_login_at IS NULL OR last_login_at < NOW() - INTERVAL '30 days')
      )::int AS inactive_users,
      COUNT(*) FILTER (WHERE status <> 'active')::int AS blocked_users
    FROM users
  `);

  return result.rows[0];
}

async function getRegisteredUsers() {
  const result = await db.query(`
    SELECT
      u.id AS user_id,
      u.phone_e164 AS registered_number,
      COALESCE(
        NULLIF(vpr.country_name, ''),
        NULLIF(u.country_code, ''),
        'Unknown'
      ) AS country_name,
      u.country_code,
      u.created_at AS registered_at,
      u.last_login_at,
      CASE
        WHEN u.status <> 'active' THEN 'Blocked'
        WHEN u.last_login_at >= NOW() - INTERVAL '30 days' THEN 'Active'
        ELSE 'Inactive'
      END AS activity_status
    FROM users u
    LEFT JOIN LATERAL (
      SELECT r.country_name, r.country_code
      FROM voice_provider_rates r
      WHERE REPLACE(u.phone_e164, '+', '') LIKE r.prefix || '%'
      ORDER BY LENGTH(r.prefix) DESC, r.id ASC
      LIMIT 1
    ) vpr ON TRUE
    ORDER BY u.created_at DESC, u.id DESC
  `);

  return result.rows;
}

module.exports = {
  getProfitSummary,
  getCallWiseProfitDetails,
  getCallCountrySummary,
  getRegisteredUserSummary,
  getRegisteredUsers,
};
