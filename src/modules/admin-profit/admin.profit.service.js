"use strict";
const db = require("../../config/db");
// Read-only reconciliation. Never debit/refund or rewrite historical calls.
// Financial totals include calls with a wallet entry or a provider actual, even if not 'charged'.
const reportSql = `WITH report AS (
 SELECT cs.id AS call_id, cs.status,
 COALESCE(NULLIF(cs.meta #>> '{pricing_snapshot,country_name}',''),NULLIF(vpr.country_name,''),NULLIF(cr.country_name,''),'Unknown') AS country_name,
 COALESCE(NULLIF(cs.meta #>> '{pricing_snapshot,country_code}',''),vpr.country_code,cr.country_code) AS country_code,
 cs.to_phone_e164 AS mobile_number, cs.started_at AS called_at,
 COALESCE(cs.charged_minutes,0) AS minutes,
 COALESCE(cs.sell_rate_usd_per_min,0) AS pm_rate,
 ledger.net / 1000000::numeric AS total_charge,
 CASE WHEN ledger.entries>0 THEN 'Posted entries matched' ELSE 'No posted wallet entry' END AS wallet_status,
 a.provider_microusd / 1000000::numeric AS provider_cost,
 CASE WHEN a.cost_status='sip_and_webrtc' THEN (ledger.net-a.provider_microusd)/1000000::numeric END AS net_profit,
 CASE WHEN a.cost_status='sip_and_webrtc' THEN 'Verified' ELSE 'Pending' END AS cost_status,
 CASE WHEN a.cost_status='sip_and_webrtc' AND ledger.net<>0 THEN ROUND((ledger.net-a.provider_microusd)*100::numeric/ledger.net,2) END AS profit_percent,
 a.updated_at AS cost_updated_at, COALESCE(vp.code,cs.provider,'unknown') AS provider
 FROM call_sessions cs
 LEFT JOIN voice_guard_actuals a ON a.session_id=cs.id
 LEFT JOIN voice_provider_rates vpr ON vpr.id=cs.provider_rate_id
 LEFT JOIN call_rates cr ON cr.id=cs.rate_id
 LEFT JOIN voice_providers vp ON vp.id=cs.provider_id
 LEFT JOIN LATERAL (
  SELECT COUNT(*) AS entries, COALESCE(SUM(CASE WHEN w.type='call_charge' THEN w.amount_microusd ELSE -w.amount_microusd END),0) AS net
  FROM wallet_transactions w WHERE w.user_id=cs.user_id AND w.status='posted'
  AND w.type IN ('call_charge','call_refund','refund')
  AND (w.idempotency_key='call_charge:'||cs.id::text OR w.meta->>'session_id'=cs.id::text)
 ) ledger ON TRUE
 WHERE (cs.status='charged' OR a.session_id IS NOT NULL OR ledger.entries>0)
 AND cs.started_at >= COALESCE((SELECT reporting_started_at FROM voice_guard_settings WHERE id=1),'-infinity'::timestamptz)
)`;
const summarySql = `COUNT(*)::int AS total_calls,
 COALESCE(SUM(minutes),0) AS total_minutes,
 COALESCE(SUM(total_charge),0) AS total_charge,
 COALESCE(SUM(total_charge) FILTER(WHERE cost_status='Verified'),0) AS verified_wallet_net,
 COALESCE(SUM(total_charge) FILTER(WHERE cost_status<>'Verified'),0) AS pending_wallet_net,
 COALESCE(SUM(provider_cost) FILTER(WHERE cost_status='Verified'),0) AS total_provider_cost,
 COALESCE(SUM(net_profit),0) AS total_net_profit,
 COUNT(*) FILTER(WHERE cost_status='Verified')::int AS verified_calls,
 COUNT(*) FILTER(WHERE cost_status<>'Verified')::int AS pending_calls,
 COALESCE(SUM(provider_cost) FILTER(WHERE cost_status<>'Verified'),0) AS pending_known_cost,
 COALESCE(ROUND(SUM(total_charge)/NULLIF(SUM(minutes),0),7),0) AS avg_sell_rate_usd_per_min,
 ROUND(SUM(net_profit)/NULLIF(SUM(total_charge) FILTER(WHERE cost_status='Verified'),0)*100,2) AS profit_percent,
 COUNT(DISTINCT country_name)::int AS destination_groups`;
async function getProfitSummary({todayOnly=false}={}) {
 const result=await db.query(reportSql+` SELECT ${summarySql} FROM report ${todayOnly ? 'WHERE called_at >= CURRENT_DATE' : ''}`);
 return {...result.rows[0],report_basis:'Posted wallet charges less refunds; profit only for matched SIP + WebRTC costs. Pending calls are excluded from verified cost/profit. Today uses database server date.'};
}
async function getCallWiseProfitDetails() {
 return (await db.query(reportSql+` SELECT * FROM report ORDER BY called_at DESC,call_id DESC`)).rows;
}
async function getCallCountrySummary() {
 return (await db.query(reportSql+` SELECT country_name,${summarySql} FROM report GROUP BY country_name ORDER BY total_net_profit DESC,country_name`)).rows;
}

async function getRegisteredUserSummary() {
  const result = await db.query(`
    WITH verified_users AS (
      SELECT
        u.id,
        u.status,

        COALESCE(
          NULLIF(vpr.country_code, ''),
          NULLIF(u.country_code, ''),
          'Unknown'
        ) AS resolved_country_code

      FROM users u

      LEFT JOIN LATERAL (
        SELECT
          r.country_code,
          r.country_name
        FROM voice_provider_rates r
        WHERE REPLACE(u.phone_e164, '+', '') LIKE r.prefix || '%'
        ORDER BY
          LENGTH(r.prefix) DESC,
          r.id ASC
        LIMIT 1
      ) vpr ON TRUE

      WHERE u.phone_verified_at IS NOT NULL
    )

    SELECT
      COUNT(*)::int AS total_registered_numbers,

      COUNT(
        DISTINCT resolved_country_code
      )::int AS unique_registration_countries,

      COUNT(*) FILTER (
        WHERE status = 'active'
      )::int AS active_users,

      COUNT(*) FILTER (
        WHERE status = 'inactive'
      )::int AS inactive_users,

      COUNT(*) FILTER (
        WHERE status = 'blocked'
      )::int AS blocked_users

    FROM verified_users
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
        WHEN u.status = 'blocked' THEN 'Blocked'
        WHEN u.status = 'inactive' THEN 'Inactive'
        WHEN u.status = 'active' THEN 'Active'
        ELSE INITCAP(COALESCE(u.status, 'inactive'))
      END AS activity_status
    FROM users u
    LEFT JOIN LATERAL (
      SELECT r.country_name, r.country_code
      FROM voice_provider_rates r
      WHERE REPLACE(u.phone_e164, '+', '') LIKE r.prefix || '%'
      ORDER BY LENGTH(r.prefix) DESC, r.id ASC
      LIMIT 1
    ) vpr ON TRUE
     WHERE u.phone_verified_at IS NOT NULL
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
