"use strict";
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto");
const db = require("../../config/db"),
  m = require("./money-routes");
const fail = (message, statusCode = 409) =>
  Object.assign(new Error(message), { statusCode });
async function transaction(fn) {
  const c = await db.getClient();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
async function settings(c = db) {
  const row = (await c.query("SELECT * FROM voice_guard_settings WHERE id=1"))
    .rows[0];
  if (!row) throw fail("Run Calling migration 039 first", 503);
  return row;
}
const caller = () => String(process.env.TELNYX_PHONE_NUMBER || "").trim();
// Missing historical cost is not evidence of an unsafe current price.
// Real losses, changed provider rates and readiness failures still block calls.
function isRateBlockingAlert(a) {
  if (a.severity === 'loss') return true;
  const missingCost = a.severity === 'warning' && String(a.alert_key || '').startsWith('missing:');
  return !missingCost && a.details?.rate_update_required === true;
}

async function audit(c, actor, action, details) {
  await c.query(
    "INSERT INTO voice_guard_audit(actor_user_id,action,details) VALUES($1,$2,$3::jsonb)",
    [actor || null, action, JSON.stringify(details)],
  );
}
async function alert(
  key,
  country,
  prefix,
  severity,
  message,
  details = {},
  c = db,
) {
  await c.query(
    `INSERT INTO voice_guard_alerts(alert_key,country_code,prefix,severity,message,details)
 VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(alert_key) DO UPDATE SET severity=EXCLUDED.severity,message=EXCLUDED.message,
 details=EXCLUDED.details,active=TRUE,updated_at=NOW(),resolved_at=NULL,resolved_by=NULL`,
    [
      key,
      country || "",
      prefix || "",
      severity,
      message,
      JSON.stringify(details),
    ],
  );
}
function readiness(s) {
  if (!s.deck_version) return "Import the current Telnyx CSV first";
  if (s.caller_number !== caller())
    return "Caller ID changed: reimport the Telnyx CSV";
  if (
    !s.imported_at ||
    Date.now() - new Date(s.imported_at).getTime() >
      s.max_deck_age_days * 86400000
  )
    return "Rate deck is stale: import the current Telnyx CSV";
  if (
    !s.monitor_verified ||
    !s.last_monitor_sync ||
    Date.now() - new Date(s.last_monitor_sync).getTime() > 15 * 60000
  )
    return "Calling cost monitor needs a successful sync";
  return null;
}
async function importDeck({
  filePath,
  providerCode = "telnyx",
  planCode = "payg",
  adminUserId = null,
  allowDuplicateChecksum = false,
}) {
  if (providerCode !== "telnyx" || planCode !== "payg")
    throw fail("Safe Calling currently supports Telnyx PAYG only", 422);
  if (!/^\+[1-9]\d{7,14}$/.test(caller()))
    throw fail("Configure the provider TELNYX_PHONE_NUMBER first", 422);
  // Strictly validate the entire file before starting a DB transaction.
  await m.readDeck(filePath, async () => {});
  const sha = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) sha.update(chunk);
  const checksum = sha.digest("hex");
  return transaction(async (c) => {
    const old = await settings(c);
    await c.query("SELECT id FROM voice_guard_settings WHERE id=1 FOR UPDATE");
    if (
      old.source_sha256 === checksum &&
      old.caller_number === caller() &&
      !allowDuplicateChecksum
    )
      return {
        ok: true,
        duplicate_import: true,
        provider_code: providerCode,
        provider_plan_code: planCode,
        source_file: path.basename(filePath),
        rate_card_code: old.deck_version,
        unique_rates_imported: Number(
          (
            await c.query(
              "SELECT COUNT(*) FROM voice_guard_deck WHERE version=$1",
              [old.deck_version],
            )
          ).rows[0].count,
        ),
        rows_skipped: 0,
      };
    const version = crypto.randomUUID();
    const count = await m.readDeck(filePath, async (batch, start) => {
      const rows = batch.map((r, i) => ({
        ordinal: start + i,
        fixed_prefix: r.fixed,
        iso: r.iso,
        country: r.country,
        eligible: m.originLength(r, caller()) >= 0,
        route: r,
      }));
      await c.query(
        `INSERT INTO voice_guard_deck(version,ordinal,fixed_prefix,iso,country,eligible,route)
   SELECT $1,x.ordinal,x.fixed_prefix,x.iso,x.country,x.eligible,x.route FROM jsonb_to_recordset($2::jsonb)
   AS x(ordinal integer,fixed_prefix text,iso text,country text,eligible boolean,route jsonb)`,
        [version, JSON.stringify(rows)],
      );
    });
    await c.query(
      "UPDATE voice_guard_settings SET deck_version=$1,source_name=$2,source_sha256=$3,imported_at=NOW(),caller_number=$4 WHERE id=1",
      [version, path.basename(filePath), checksum, caller()],
    );
    // Keep prior versions as audit evidence; no old invoices or provider imports are deleted.
    await audit(c, adminUserId, "calling_deck_imported", {
      version,
      checksum,
      rows: count,
      caller: caller(),
    });
    return {
      ok: true,
      duplicate_import: false,
      provider_code: providerCode,
      provider_plan_code: planCode,
      source_file: path.basename(filePath),
      rate_card_code: version,
      unique_rates_imported: count,
      rows_skipped: 0,
    };
  });
}
async function validateDeck({ filePath, sampleLimit = 10 }) {
  const sample = [],
    unique = new Set();
  const n = await m.readDeck(filePath, async (batch) => {
    for (const r of batch) {
      unique.add(r.prefix);
      if (sample.length < Math.min(50, sampleLimit))
        sample.push({
          country_code: r.iso,
          country_name: r.country,
          prefix: r.prefix,
          raw_rate_usd_per_min: m.usd(r.rate),
          destination_name: r.description,
          origin: r.origin,
        });
    }
  });
  const sha = crypto.createHash("sha256");
  for await (const part of fs.createReadStream(filePath)) sha.update(part);
  return {
    ok: true,
    dry_run: true,
    source_file: path.basename(filePath),
    source_sha256: sha.digest("hex"),
    total_lines_read: n + 1,
    data_rows_read: n,
    valid_rows: n,
    rows_valid: n,
    rows_skipped: 0,
    invalid_rows: 0,
    unique_prefixes: unique.size,
    duplicate_prefix_rows: n - unique.size,
    skipped_by_reason: {},
    sample_rows: sample,
    samples: sample,
  };
}

async function selectRoute(phone, s, c = db) {
  const n = m.digits(phone);
  if (!/^[1-9]\d{7,14}$/.test(n))
    throw fail("Use an international phone number", 422);
  const prefixes = Array.from({ length: n.length }, (_, i) =>
    n.slice(0, i + 1),
  );
  const rows = (
    await c.query(
      "SELECT route FROM voice_guard_deck WHERE version=$1 AND fixed_prefix=ANY($2::text[])",
      [s.deck_version, prefixes],
    )
  ).rows.map((x) => x.route);
  return m.select(rows, n, caller());
}
async function policy(phone, country, c = db) {
  const n = m.digits(phone);
  return (
    (
      await c.query(
        "SELECT * FROM voice_guard_policies WHERE country_code=$2 AND (scope='country' OR $1 LIKE prefix||'%') ORDER BY (scope='prefix') DESC,length(prefix) DESC LIMIT 1",
        [n, country],
      )
    ).rows[0] || {}
  );
}
function prices(r, p, s) {
  return m.pricing(
    r,
    { markup_percent: s.default_markup, ...p },
    s.sdk_microusd,
  );
}
async function tryResolve(phone) {
  const s = await settings();
  if (!s.enabled)
    return {
      ok: false,
      reason: "safe_calling_activation_required",
      disabled_reason:
        "Calling rate update in progress. Please try again later.",
    };
  return resolve(phone, s);
}
async function resolve(phone, config) {
  const s = config || (await settings());
  const reason = readiness(s);
  if (reason)
    return {
      ok: false,
      reason: "calling_guard_not_ready",
      disabled_reason: reason,
    };
  const repo = require("../calls/provider-router.repository");
  const destination = await repo.findDestinationPolicy(phone);
  if (destination?.is_enabled === false)
    return {
      ok: false,
      reason: "destination_disabled",
      disabled_reason: destination.disabled_reason,
    };
  let r;
  try {
    r = await selectRoute(phone, s);
  } catch (e) {
    return {
      ok: false,
      reason: "unverified_destination_rate",
      disabled_reason: e.message,
    };
  }
  const p = await policy(phone, r.iso.split("/")[0]);
  const countryDisabled =
    (
      await db.query(
        "SELECT 1 FROM voice_guard_policies WHERE country_code=$1 AND scope='country' AND is_active=FALSE LIMIT 1",
        [r.iso.split("/")[0]],
      )
    ).rows.length > 0;
  if (p.is_active === false || countryDisabled)
    return {
      ok: false,
      reason: "destination_disabled",
      disabled_reason: "Disabled by Admin",
    };
  const losses = (
    await db.query(
      "SELECT alert_key,severity,details FROM voice_guard_alerts WHERE active AND (severity='loss' OR details->>'rate_update_required'='true') AND (country_code=$1 OR country_code='') AND (prefix='' OR $2 LIKE prefix||'%')",
      [r.iso.split("/")[0], m.digits(phone)],
    )
  ).rows.filter(isRateBlockingAlert);
  if (losses.length)
    return {
      ok: false,
      reason: "country_loss_blocked",
      disabled_reason: "Rate update required. Admin has been notified.",
    };
  const price = prices(r, p, s);
  if (!price.safe) {
    await alert(
      "manual:" + r.iso,
      r.iso.split("/")[0],
      r.prefix,
      "loss",
      "Manual sell rate is below provider cost. Update this country rate.",
      {
        estimated: true,
        provider_usd: m.usd(price.cost),
        sell_usd: m.usd(price.sell),
      },
    );
    return {
      ok: false,
      reason: "manual_rate_below_provider_cost",
      disabled_reason: "Admin rate update required",
    };
  }
  const route = await repo.findActiveRoute(phone);
  if (!route) return { ok: false, reason: "active_route_not_found" };
  const candidates = await repo.findRouteProviderCandidates(route.id);
  const candidate = candidates.find(
    (x) =>
      x.provider_code === "telnyx" &&
      (!x.provider_plan_code || x.provider_plan_code === "payg"),
  );
  if (!candidate)
    return { ok: false, reason: "active_telnyx_provider_not_found" };
  const ceiling = [
    candidate.max_provider_rate_usd_min,
    route.max_provider_rate_usd_min,
    destination?.max_provider_rate_usd_min,
  ]
    .map(Number)
    .filter((x) => x > 0);
  if (ceiling.length && m.usd(price.cost) > Math.min(...ceiling))
    return { ok: false, reason: "provider_rate_exceeds_admin_limit" };
  return {
    ok: true,
    source: "telnyx_origin_csv_guard",
    destination_policy: destination,
    route,
    route_provider: candidate,
    provider: {
      id: candidate.provider_id,
      code: "telnyx",
      name: candidate.provider_name,
      type: candidate.provider_type,
    },
    provider_plan: {
      id: candidate.provider_plan_id,
      code: candidate.provider_plan_code || "payg",
      discount_percent: 0,
    },
    provider_rate: {
      provider_rate_id: null,
      rate_card_id: null,
      country_code: r.iso.split("/")[0],
      country_name: r.country,
      destination_name: r.description,
      prefix: r.prefix,
      raw_rate_usd_per_min: m.usd(r.rate),
      connection_fee_usd: m.usd(r.fee),
      billing_increment_seconds: r.next,
      minimum_duration_seconds: r.first,
    },
    pricing: {
      raw_provider_rate_usd_per_min: m.usd(r.rate),
      discounted_provider_rate_usd_per_min: m.usd(r.rate),
      discount_percent: 0,
      platform_fee_usd_per_min: m.usd(s.sdk_microusd),
      total_provider_cost_usd_per_min: m.usd(price.cost),
      sell_rate_usd_per_min: m.usd(price.sell),
      markup_percent: price.percent,
      min_profit_usd_per_min: 0,
      provider_connection_fee_usd: m.usd(r.fee),
      customer_connection_fee_usd: m.usd(price.connection),
      billing_increment_seconds: r.next,
      minimum_duration_seconds: r.first,
    },
    guard_snapshot: {
      version: s.deck_version,
      prefix: r.prefix,
      origin: r.origin,
      caller: caller(),
      pricing_mode: price.mode,
      markup_percent: price.percent,
      sdk_microusd: String(s.sdk_microusd),
    },
    rejected_providers: [],
  };
}
async function countries({ search = "" } = {}) {
  const s = await settings();
  if (!s.deck_version) return [];
  const q = String(search).trim();
  if (q.length > 100) throw fail("Search too long", 422);
  const rows = (
    await db.query(
      `WITH eligible AS (
 SELECT d.*,CASE WHEN d.route->>'origin'='' THEN 0 ELSE
 (SELECT MAX(length(trim(x))) FROM unnest(string_to_array(d.route->>'origin',',')) x
 WHERE $6 LIKE trim(x)||'%') END AS specificity
 FROM voice_guard_deck d WHERE d.version=$1 AND d.eligible
 ), ranked AS (
 SELECT *,MAX(specificity) OVER(PARTITION BY route->>'prefix',route->>'exact') AS best_origin FROM eligible
 ), priced AS (
 SELECT d.*,((d.route->>'rate')::bigint+$7::bigint) AS cost,
 CASE WHEN p.pricing_mode='manual_rate' THEN CEIL(p.manual_sell_rate_usd_per_min*1000000)::bigint
 ELSE CEIL(((d.route->>'rate')::bigint+$7::bigint)*(100+COALESCE(p.markup_percent,$8::numeric))/100)::bigint END AS sell
 FROM ranked d LEFT JOIN LATERAL (
 SELECT * FROM voice_guard_policies p WHERE p.country_code=split_part(d.iso,'/',1)
 AND (p.scope='country' OR d.fixed_prefix LIKE p.prefix||'%')
 ORDER BY (p.scope='prefix') DESC,length(p.prefix) DESC LIMIT 1
 ) p ON TRUE WHERE d.specificity=d.best_origin
 ) SELECT split_part(d.iso,'/',1) AS iso,MIN(d.country) AS country,COUNT(*) AS count,
 MIN((d.route->>'rate')::bigint) AS min_rate,MAX((d.route->>'rate')::bigint) AS max_rate,
 MIN(d.cost) AS min_cost,MAX(d.cost) AS max_cost,MIN(d.sell) AS min_sell,MAX(d.sell) AS max_sell,
 MIN(d.sell-d.cost) AS min_profit,BOOL_OR(d.sell<=d.cost) AS unsafe,
 (array_agg(d.fixed_prefix ORDER BY length(d.fixed_prefix),d.ordinal))[1] AS prefix,
 MAX((d.route->>'fee')::bigint) AS max_fee
 FROM priced d WHERE ($2='' OR d.country ILIKE $3 OR split_part(d.iso,'/',1)=$4 OR d.fixed_prefix LIKE $5)
 GROUP BY split_part(d.iso,'/',1) ORDER BY MIN(d.country)`,
      [
        s.deck_version,
        q,
        "%" + q + "%",
        q.toUpperCase(),
        q.replace(/^\+/, "") + "%",
        m.digits(caller()),
        s.sdk_microusd,
        s.default_markup,
      ],
    )
  ).rows;
  const policies = (await db.query("SELECT * FROM voice_guard_policies ORDER BY updated_at DESC")).rows;
  const activeAlerts = (
    await db.query(
      "SELECT * FROM voice_guard_alerts WHERE active ORDER BY updated_at DESC",
    )
  ).rows;
  const allowed = (
    await db.query("SELECT country_code,prefix,is_active FROM voice_routes")
  ).rows;
  return rows.map((row) => {
    const iso = row.iso.split("/")[0],
      r = { rate: row.min_rate, fee: "0" },
      hi = { rate: row.max_rate, fee: row.max_fee };
    // Summary is labelled as a range; actual calls resolve their own destination prefix.
    const pp =
      policies.find((x) => x.scope === "country" && x.country_code === iso) ||
      {};
    const lo = prices(r, pp, s),
      high = prices(hi, pp, s);
    const countryAlerts = activeAlerts.filter(
      (a) => !a.country_code || a.country_code === iso,
    );
    const blocked =
      countryAlerts.some(
        (a) =>
          isRateBlockingAlert(a) && (!a.prefix || a.prefix === row.prefix),
      ) || (row.unsafe && pp.pricing_mode === "manual_rate");
    const enabled =
      typeof pp.is_active === "boolean" ? pp.is_active :
      allowed.some((x) => x.country_code === iso && x.is_active);
    return {
      country_code: iso,
      country_name: row.country,
      prefix: row.prefix,
      route_code: "safe-csv",
      route_name: row.country,
      provider_code: "telnyx",
      provider_name: "Telnyx",
      provider_plan_code: "payg",
      raw_provider_rate_usd_per_min: m.usd(row.min_rate),
      discounted_provider_rate_usd_per_min: m.usd(row.min_rate),
      platform_fee_usd_per_min: m.usd(s.sdk_microusd),
      provider_cost_usd_per_min: m.usd(row.min_cost),
      provider_max_usd_per_min: m.usd(row.max_cost),
      csv_min_usd_per_min: m.usd(row.min_rate),
      csv_max_usd_per_min: m.usd(row.max_rate),
      pricing_mode: pp.pricing_mode || "auto_markup",
      markup_percent: lo.percent,
      manual_sell_rate_usd_per_min: pp.manual_sell_rate_usd_per_min || null,
      manual_override: pp.pricing_mode === "manual_rate",
      min_profit_usd_per_min: 0,
      final_sell_rate_usd_per_min: m.usd(row.min_sell),
      sell_max_usd_per_min: m.usd(row.max_sell),
      profit_usd_per_min: m.usd(row.min_profit),
      effective_markup_percent: m.usd(lo.cost)
        ? (m.usd(lo.sell) / m.usd(lo.cost) - 1) * 100
        : 0,
      profit_margin_percent: m.usd(lo.sell)
        ? (m.usd(lo.sell - lo.cost) / m.usd(lo.sell)) * 100
        : 0,
      destination_rate_count: Number(row.count),
      billing_increment_seconds: 60,
      minimum_duration_seconds: 60,
      connection_fee_usd: m.usd(row.max_fee),
      is_active: enabled,
      publish_rate: enabled && !blocked,
      has_loss: blocked,
      partial_review: Boolean(row.unsafe && pp.pricing_mode !== 'manual_rate') || countryAlerts.some(a => a.prefix && a.prefix !== row.prefix && isRateBlockingAlert(a)),
      prefix_override_count: policies.filter(p => p.scope === 'prefix' && p.country_code === iso).length,
      alerts: countryAlerts,
      guard_enabled: s.enabled,
      guard_ready: !readiness(s),
      monitor_error: s.monitor_error,
      deck_source: s.source_name,
      deck_imported_at: s.imported_at,
      note: pp.note || null,
      updated_at: pp.updated_at || s.imported_at,
    };
  });
}
async function getCountry(prefix, country) {
  const rows = await countries();
  return (
    rows.find(
      (x) => x.prefix === prefix && (!country || x.country_code === country),
    ) || null
  );
}
async function refreshManualAlert(countryCode) {
  const items = await countries({search:countryCode});
  if (items.length && items.every(item => item.profit_usd_per_min > 0)) {
    await db.query("UPDATE voice_guard_alerts SET active=FALSE,resolved_at=NOW() WHERE country_code=$1 AND active AND alert_key LIKE 'manual:%' AND details->>'estimated'='true'", [countryCode]);
  }
}
async function ensureCountrySetup(c, current, prefix, actor) {
  const provider = (await c.query("SELECT id FROM voice_providers WHERE code='telnyx' AND status='active' AND supports_voice=TRUE")).rows[0];
  if (!provider) throw fail('Active Telnyx provider is missing; country was not enabled', 409);
  const plan = (await c.query("SELECT id FROM voice_provider_plans WHERE provider_id=$1 AND code='payg' AND is_active=TRUE AND (valid_from IS NULL OR valid_from<=NOW()) AND (valid_until IS NULL OR valid_until>NOW())", [provider.id])).rows[0];
  if (!plan) throw fail('Active Telnyx PAYG plan is missing; country was not enabled', 409);
  // Missing legacy route rows must be created, not silently ignored by UPDATE.
  const existing = (await c.query('SELECT id,country_code FROM voice_routes WHERE prefix=$1 FOR UPDATE',[prefix])).rows[0];
  if (existing && existing.country_code !== current.country_code) throw fail('Shared prefix route requires review; country was not enabled',409);
  if (!existing) await c.query("INSERT INTO voice_routes(code,name,country_code,prefix,is_active) VALUES($1,$2,$3,$4,TRUE)", ['csv-'+current.country_code.toLowerCase()+'-'+prefix,current.country_name,current.country_code,prefix]);
  const dest = (await c.query('SELECT country_code FROM voice_destination_policies WHERE prefix=$1 FOR UPDATE',[prefix])).rows[0];
  if (dest && dest.country_code !== current.country_code) throw fail('Shared destination prefix requires review; country was not enabled',409);
  if (!dest) await c.query('INSERT INTO voice_destination_policies(country_code,prefix,destination_name,is_enabled) VALUES($1,$2,$3,TRUE)',[current.country_code,prefix,current.country_name]);
  const routes = (await c.query('SELECT id FROM voice_routes WHERE country_code=$1',[current.country_code])).rows;
  for (const route of routes) {
    const link = (await c.query('SELECT id FROM voice_route_providers WHERE route_id=$1 AND provider_id=$2',[route.id,provider.id])).rows[0];
    if (!link) await c.query('INSERT INTO voice_route_providers(route_id,provider_id,provider_plan_id,is_active) VALUES($1,$2,$3,TRUE)',[route.id,provider.id,plan.id]);
    // Existing provider limits, validity windows and disabled links remain explicit controls.
  }
  await audit(c,actor,'calling_country_setup_ensured',{country_code:current.country_code,prefix});
}
async function reviewSavedPricing(countryCode, prefix, actor) {
  const { rows } = await db.query("SELECT alert_key,prefix FROM voice_guard_alerts WHERE active AND country_code=$1 AND severity='loss' AND ($2::text IS NULL OR prefix=$2) ORDER BY updated_at DESC", [countryCode,prefix]);
  const failures = [];
  for (const a of rows) {
    try { await resolveAlert(a.alert_key, actor); }
    catch (e) { failures.push(String(e.message)); }
  }
  return {review_message: failures.length ? 'Price saved. Review still required: ' + [...new Set(failures)].join('; ') : 'Price saved. Current rates verified; historical losses remain recorded.'};
}
async function saveCountry({ prefix, adminUserId, payload }) {
  const current = await getCountry(prefix, payload.country_code);
  if (!current) return { ok: false, reason: "country_route_not_found" };
  const mode = payload.pricing_mode;
  if (!["auto_markup", "manual_rate"].includes(mode))
    throw fail("Invalid pricing mode", 422);
  const percent = Number(payload.markup_percent ?? 30);
  if (mode === "auto_markup") m.markup(1n, percent);
  else if (m.micro(String(payload.manual_sell_rate_usd_per_min)) <= 0n)
    throw fail("Manual rate must be positive", 422);
  await transaction(async (c) => {
    await c.query(
      `INSERT INTO voice_guard_policies(prefix,country_code,pricing_mode,markup_percent,manual_sell_rate_usd_per_min,is_active,note,updated_by)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(prefix,country_code,scope) DO UPDATE SET pricing_mode=EXCLUDED.pricing_mode,markup_percent=EXCLUDED.markup_percent,
  manual_sell_rate_usd_per_min=EXCLUDED.manual_sell_rate_usd_per_min,is_active=EXCLUDED.is_active,note=EXCLUDED.note,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [
        prefix,
        current.country_code,
        mode,
        percent,
        mode === "manual_rate" ? payload.manual_sell_rate_usd_per_min : null,
        payload.is_active ?? current.is_active,
        payload.note || null,
        adminUserId,
      ],
    );
    if (typeof payload.is_active === 'boolean') {
      // A country may have several stored policies: never leave an older disabled country row behind.
      await c.query("UPDATE voice_guard_policies SET is_active=$2,updated_at=NOW() WHERE country_code=$1 AND scope='country'", [current.country_code,payload.is_active]);
      if (payload.is_active) await ensureCountrySetup(c, current, prefix, adminUserId);

      const routes = (await c.query("SELECT id,is_active FROM voice_routes WHERE country_code=$1", [current.country_code])).rows;
      const destinations = (await c.query("SELECT id,is_enabled FROM voice_destination_policies WHERE country_code=$1", [current.country_code])).rows;
      await audit(c, adminUserId, "calling_country_enabled_changed", {country_code:current.country_code, routes, destinations, enabled:payload.is_active});
      await c.query("UPDATE voice_routes SET is_active=$2 WHERE country_code=$1", [current.country_code,payload.is_active]);
      await c.query("UPDATE voice_destination_policies SET is_enabled=$2,disabled_reason=CASE WHEN $2 THEN NULL ELSE 'Disabled by Admin' END WHERE country_code=$1", [current.country_code,payload.is_active]);
    }
    if (payload.apply_to_all_prefixes === true) {
      const old = (await c.query("SELECT * FROM voice_guard_policies WHERE country_code=$1 AND scope='prefix'", [current.country_code])).rows;
      await audit(c, adminUserId, "calling_prefix_prices_replaced", {country_code:current.country_code, previous:old});
      await c.query("UPDATE voice_guard_policies SET pricing_mode=$2,markup_percent=$3,manual_sell_rate_usd_per_min=$4,updated_by=$5,updated_at=NOW() WHERE country_code=$1 AND scope='prefix'", [current.country_code,mode,percent,mode==='manual_rate'?payload.manual_sell_rate_usd_per_min:null,adminUserId]);
    }
    await audit(c, adminUserId, "calling_country_policy_saved", {
      prefix,
      payload,
    });
  });
  await refreshManualAlert(current.country_code);
  // Below-cost manual choices are saved visibly, but unsafe new calls are blocked.
  const item = await getCountry(prefix, current.country_code);
  if (item.profit_usd_per_min <= 0 && !item.alerts.some((x) => x.severity === "loss"))
    await alert(
      "manual:" + current.country_code,
      current.country_code,
      prefix,
      "loss",
      "Manual rate does not cover every route. Raise the rate or use Auto 30%.",
      { estimated: true },
    );
  await reviewSavedPricing(current.country_code, null, adminUserId);
  return { ok: true, data: await getCountry(prefix, current.country_code) };
}
async function resetCountry({ prefix, adminUserId, countryCode }) {
  return saveCountry({
    prefix,
    adminUserId,
    payload: {
      country_code: countryCode,
      pricing_mode: "auto_markup",
      markup_percent: 30,
    },
  });
}
async function routeRows(
  prefix,
  { search = "", offset = 0, country_code = null } = {},
) {
  search = String(search);
  if (search.length > 100) throw fail("Search too long", 422);
  const s = await settings();
  const n = Number(offset);
  if (!Number.isSafeInteger(n) || n < 0 || n > 300000)
    throw fail("Invalid offset", 422);
  const country = await getCountry(prefix, country_code);
  if (!country) throw fail("Country not found", 404);
  const rows = (
    await db.query(
      `SELECT route FROM voice_guard_deck WHERE version=$1 AND eligible AND split_part(iso,'/',1)=$2
 AND ($3='' OR route->>'description' ILIKE $4 OR fixed_prefix LIKE $5) ORDER BY ordinal LIMIT 51 OFFSET $6`,
      [
        s.deck_version,
        country.country_code,
        search,
        "%" + search + "%",
        search + "%",
        n,
      ],
    )
  ).rows;
  const rules = (await db.query("SELECT * FROM voice_guard_policies ORDER BY updated_at DESC")).rows;
  return {
    more: rows.length > 50,
    items: await Promise.all(
      rows.slice(0, 50).map(async ({ route: r }) => {
        const p =
            rules
              .filter(
                (x) =>
                  x.country_code === r.iso.split("/")[0] &&
                  (x.scope === "country" || r.fixed.startsWith(x.prefix)),
              )
              .sort(
                (a, b) =>
                  Number(b.scope === "prefix") - Number(a.scope === "prefix") ||
                  b.prefix.length - a.prefix.length,
              )[0] || {},
          price = prices(r, p, s);
        return {
          ...r,
          pricing_mode: price.mode,
          markup_percent: price.percent,
          manual_sell_rate_usd_per_min: p.manual_sell_rate_usd_per_min,
          raw_provider_usd: m.usd(r.rate),
          total_provider_usd: m.usd(price.cost),
          sell_usd: m.usd(price.sell),
          fee_usd: m.usd(r.fee),
          safe: price.safe,
        };
      }),
    ),
  };
}
async function health() {
  const s = await settings();
  const issue = readiness(s);
  if (
    s.deck_version &&
    s.imported_at &&
    Date.now() - new Date(s.imported_at).getTime() >
      (s.max_deck_age_days - 3) * 86400000
  )
    await alert(
      "csv-due",
      "",
      "",
      "warning",
      "CSV refresh is due soon. Download the latest account rate deck and import it.",
      { imported_at: s.imported_at },
    );
  else
    await db.query(
      "UPDATE voice_guard_alerts SET active=FALSE,resolved_at=NOW() WHERE alert_key='csv-due'",
    );
  if (s.enabled && issue)
    await alert("readiness", "", "", "warning", issue, {
      rate_update_required: true,
    });
  else
    await db.query(
      "UPDATE voice_guard_alerts SET active=FALSE,resolved_at=NOW() WHERE alert_key='readiness'",
    );
  const alerts = (
    await db.query(
      "SELECT * FROM voice_guard_alerts WHERE active ORDER BY updated_at DESC LIMIT 100",
    )
  ).rows;
  return {
    ...s,
    readiness_error: readiness(s),
    monitor_warning: s.monitor_error || null,
    alerts,
    actuals: (
      await db.query(
        "SELECT a.* FROM voice_guard_actuals a JOIN call_sessions cs ON cs.id=a.session_id WHERE cs.started_at >= COALESCE((SELECT reporting_started_at FROM voice_guard_settings WHERE id=1),'-infinity'::timestamptz) ORDER BY a.updated_at DESC LIMIT 50",
      )
    ).rows,
  };
}
async function enable(value, actor) {
  if (typeof value !== "boolean") throw fail("Boolean enabled required", 422);
  await transaction(async (c) => {
    await c.query("SELECT id FROM voice_guard_settings WHERE id=1 FOR UPDATE");
    const s = await settings(c);
    if (value && readiness(s)) throw fail(readiness(s));
    await c.query("UPDATE voice_guard_settings SET enabled=$1 WHERE id=1", [
      value,
    ]);
    await audit(c, actor, "calling_guard_enabled", { enabled: value });
  });
  return health();
}
async function resolveAlert(key, actor) {
  const a = (
    await db.query(
      "SELECT * FROM voice_guard_alerts WHERE alert_key=$1 AND active",
      [key],
    )
  ).rows[0];
  if (!a) return { ok: true };
  const s = await settings();
  if (readiness(s)) throw fail(readiness(s));
  if (a.alert_key.startsWith("missing:")) {
    const complete = (
      await db.query(
        "SELECT 1 FROM voice_guard_actuals WHERE session_id=$1 AND cost_status='sip_and_webrtc'",
        [a.details.session_id],
      )
    ).rows;
    if (!complete.length) throw fail("Match both SIP and WebRTC reports first");
  }
  if (a.alert_key.startsWith("budget:")) {
    const active = (
      await db.query(
        "SELECT 1 FROM call_sessions WHERE id=$1 AND ended_at IS NULL",
        [a.details.session_id],
      )
    ).rows;
    if (active.length) throw fail("End and review this active call first");
  }
  if (a.alert_key === "sdk-rate-change") {
    const high = (
      await db.query(
        "SELECT 1 FROM voice_guard_usage WHERE kind='webrtc' AND updated_at>NOW()-INTERVAL '7 days' AND rate_microusd>$1 LIMIT 1",
        [s.sdk_microusd],
      )
    ).rows;
    if (high.length)
      throw fail(
        "The configured WebRTC cost still understates a recent provider rate",
      );
  }
  if (a.country_code) {
    const cc = await countries({ search: a.country_code });
    if (cc.some((x) => x.profit_usd_per_min <= 0))
      throw fail("Fix the below-cost manual rate first");
    // New CDR rates must be represented by the current CSV before a loss block can be cleared.
    const bad = (
      await db.query(
        `SELECT a.session_id FROM voice_guard_actuals a JOIN call_sessions s ON s.id=a.session_id
 WHERE a.country_code=$1 AND (a.profit_microusd<0 OR a.session_id=$2) ORDER BY (a.session_id=$2) DESC,a.updated_at DESC LIMIT 100`,
        [a.country_code, a.details?.session_id || null],
      )
    ).rows;
    for (const b of bad) {
      const call = (
        await db.query("SELECT * FROM call_sessions WHERE id=$1", [
          b.session_id,
        ])
      ).rows[0];
      let r;
      try {
        r = await selectRoute(call.to_phone_e164, s);
      } catch (_) {
        throw fail("No verified route for the loss-making call");
      }
      const sid = call.meta?.telnyx_call_session_id;
      const observed = (
        await db.query(
          "SELECT rate_microusd FROM voice_guard_usage WHERE kind='sip-trunking' AND session_uuid=$1 AND direction='outbound' AND rate_microusd IS NOT NULL",
          [sid],
        )
      ).rows;
      if (observed.some((x) => BigInt(x.rate_microusd) > BigInt(r.rate)))
        throw fail(
          "The current CSV still understates the CDR rate. Import an updated provider deck",
        );
      const web = (
        await db.query(
          "SELECT rate_microusd FROM voice_guard_usage WHERE kind='webrtc' AND session_uuid=$1 AND rate_microusd IS NOT NULL",
          [sid],
        )
      ).rows;
      if (web.some((x) => BigInt(x.rate_microusd) > BigInt(s.sdk_microusd)))
        throw fail(
          "Update the configured WebRTC cost before clearing this alert",
        );
    }
  }
  await transaction(async (c) => {
    await c.query(
      "UPDATE voice_guard_alerts SET active=FALSE,resolved_at=NOW(),resolved_by=$2 WHERE alert_key=$1",
      [key, actor],
    );
    await audit(c, actor, "calling_alert_resolved", { key });
  });
  return { ok: true };
}
module.exports = {
  settings,
  transaction,
  audit,
  alert,
  readiness,
  importDeck,
  validateDeck,
  selectRoute,
  policy,
  prices,
  tryResolve,
  resolve,
  countries,
  getCountry,
  saveCountry,
  resetCountry,
  routeRows,
  health,
  enable,
  resolveAlert,
};

function budgetSeconds(balanceMicro, sellMicro, connectionMicro, first, next) {
  const money = BigInt(balanceMicro) - BigInt(connectionMicro);
  if (money <= 0n || BigInt(sellMicro) <= 0n) return 0;
  const sec = Number((money * 60n) / BigInt(sellMicro));
  if (sec < first) return 0;
  const units = Math.min(
    first + Math.floor((sec - first) / next) * next,
    Math.floor(sec / 60) * 60,
  );
  return Math.min(7200, Math.max(0, units - 10)); // Network/hangup safety margin; no unlimited calls.
}
async function admit(session, rate) {
  return transaction(async (c) => {
    await c.query("SELECT id FROM voice_guard_settings WHERE id=1 FOR SHARE");
    const current = await settings(c),
      quoted = session.meta?.calling_rate_guard;
    if (
      !current.enabled ||
      readiness(current) ||
      !quoted?.version ||
      quoted.version !== current.deck_version
    )
      throw fail("Calling rates changed. Please start the call again");
    const blocked = (
      await c.query(
        "SELECT alert_key,severity,details FROM voice_guard_alerts WHERE active AND (severity='loss' OR details->>'rate_update_required'='true') AND (country_code='' OR country_code=$1) AND (prefix='' OR $2 LIKE prefix||'%')",
        [quoted.country_code || "", m.digits(session.to_phone_e164)],
      )
    ).rows.filter(isRateBlockingAlert);
    if (blocked.length) throw fail("Calling rate review required");
    await c.query("SELECT pg_advisory_xact_lock(73421,$1::integer)", [
      session.user_id,
    ]);
    const busy = (
      await c.query(
        `SELECT id FROM call_sessions WHERE user_id=$1 AND id<>$2
  AND (ended_at IS NULL OR (answered_at IS NOT NULL AND duration_sec IS NULL))
  AND meta->>'calling_guard_admitted'='true' AND status NOT IN ('failed','charged') LIMIT 1`,
        [session.user_id, session.id],
      )
    ).rows;
    if (busy.length)
      throw fail("Another call is already active for this account");
    const wallet = (
      await c.query(
        "SELECT balance_microusd FROM wallets WHERE user_id=$1 FOR UPDATE",
        [session.user_id],
      )
    ).rows[0];
    const max = budgetSeconds(
      wallet?.balance_microusd || 0,
      m.micro(String(rate.sell_rate_usd_per_min)),
      m.micro(String(rate.customer_connection_fee_usd)),
      rate.minimum_duration_seconds,
      rate.billing_increment_seconds,
    );
    if (max < 1)
      throw fail("Insufficient wallet balance for a safely bounded call", 402);
    const saved = (
      await c.query(
        `UPDATE call_sessions SET meta=meta||jsonb_build_object('calling_guard_admitted',TRUE,
  'calling_rate_guard',meta->'calling_rate_guard'||jsonb_build_object('max_seconds',$2::integer)) WHERE id=$1 RETURNING *`,
        [session.id, max],
      )
    ).rows[0];
    return saved;
  });
}
async function saveRoutePolicy({ prefix, adminUserId, payload }) {
  if (!/^[1-9]\d{0,14}$/.test(prefix))
    throw fail("Use a numeric destination prefix", 422);
  const s = await settings();
  const rows = (
    await db.query(
      "SELECT route FROM voice_guard_deck WHERE version=$1 AND route->>'prefix'=$2 AND eligible AND ($3::text IS NULL OR split_part(iso,'/',1)=$3) LIMIT 50",
      [s.deck_version, prefix, payload.country_code || null],
    )
  ).rows;
  if (!rows.length) throw fail("CSV prefix not found", 404);
  const r = rows[0].route;
  if (!["auto_markup", "manual_rate"].includes(payload.pricing_mode))
    throw fail("Invalid pricing mode", 422);
  const mark = Number(payload.markup_percent ?? 30);
  m.markup(1n, mark);
  const manual =
    payload.pricing_mode === "manual_rate"
      ? m.micro(String(payload.manual_sell_rate_usd_per_min))
      : null;
  if (manual !== null && manual <= 0n)
    throw fail("Manual rate must be positive", 422);
  await transaction(async (c) => {
    await c.query(
      `INSERT INTO voice_guard_policies(prefix,country_code,pricing_mode,markup_percent,manual_sell_rate_usd_per_min,is_active,updated_by,scope)
 VALUES($1,$2,$3,$4,$5,TRUE,$6,'prefix') ON CONFLICT(prefix,country_code,scope) DO UPDATE SET pricing_mode=EXCLUDED.pricing_mode,markup_percent=EXCLUDED.markup_percent,
 manual_sell_rate_usd_per_min=EXCLUDED.manual_sell_rate_usd_per_min,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [
        prefix,
        r.iso.split("/")[0],
        payload.pricing_mode,
        mark,
        manual === null ? null : m.usd(manual),
        adminUserId,
      ],
    );
    await audit(c, adminUserId, "calling_prefix_policy_saved", {
      prefix,
      payload,
    });
  });
  if (
    manual !== null &&
    rows.some(
      ({ route }) => manual <= BigInt(route.rate) + BigInt(s.sdk_microusd),
    )
  )
    await alert(
      "manual:" + r.iso.split("/")[0],
      r.iso.split("/")[0],
      prefix,
      "loss",
      "Below-cost manual prefix rate: new calls are paused until review.",
      { estimated: true },
    );
  await refreshManualAlert(r.iso.split("/")[0]);
  const review = await reviewSavedPricing(r.iso.split("/")[0], prefix, adminUserId);
  return { ok: true, data: review };
}
async function configure(body, actor) {
  const days = Number(body.max_deck_age_days),
    sdk = m.micro(String(body.sdk_usd_per_min));
  if (!Number.isSafeInteger(days) || days < 1 || days > 90 || sdk > 1000000n)
    throw fail(
      "Rate age must be 1–90 days; WebRTC rate must be $0–$1/minute",
      422,
    );
  await transaction(async (c) => {
    await c.query(
      "UPDATE voice_guard_settings SET max_deck_age_days=$1,sdk_microusd=$2 WHERE id=1",
      [days, sdk.toString()],
    );
    await audit(c, actor, "calling_cost_settings_updated", {
      days,
      sdk_microusd: sdk.toString(),
    });
  });
  return health();
}
module.exports.budgetSeconds = budgetSeconds;
module.exports.admit = admit;
module.exports.saveRoutePolicy = saveRoutePolicy;
module.exports.configure = configure;

module.exports.isRateBlockingAlert = isRateBlockingAlert;
