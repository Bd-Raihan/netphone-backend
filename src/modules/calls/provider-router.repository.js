const db = require("../../config/db");

/**
 * E.164 phone number থেকে শুধু digit রাখে।
 *
 * Example:
 * +96512345678 -> 96512345678
 */
function cleanPhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

/**
 * Destination-এর জন্য longest-prefix policy খুঁজে দেয়।
 */
async function findDestinationPolicy(toPhoneE164) {
  const phone = cleanPhone(toPhoneE164);

  if (!phone) {
    return null;
  }

  const { rows } = await db.query(
    `
    SELECT
      id,
      country_code,
      prefix,
      destination_name,
      is_enabled,
      publish_rates,
      max_provider_rate_usd_min,
      markup_percent,
      min_profit_usd_per_min,
      pricing_tier,
      disabled_reason,
      valid_from,
      valid_until,
      metadata
    FROM voice_destination_policies
    WHERE $1 LIKE prefix || '%'
      AND (valid_from IS NULL OR valid_from <= NOW())
      AND (valid_until IS NULL OR valid_until > NOW())
    ORDER BY LENGTH(prefix) DESC
    LIMIT 1
    `,
    [phone]
  );

  return rows[0] || null;
}

/**
 * Destination-এর জন্য longest-prefix active route খুঁজে দেয়।
 */
async function findActiveRoute(toPhoneE164) {
  const phone = cleanPhone(toPhoneE164);

  if (!phone) {
    return null;
  }

  const { rows } = await db.query(
    `
    SELECT
      id,
      code,
      name,
      country_code,
      prefix,
      strategy,
      max_provider_rate_usd_min,
      markup_percent,
      min_profit_usd_per_min,
      metadata
    FROM voice_routes
    WHERE is_active = TRUE
      AND $1 LIKE prefix || '%'
      AND (valid_from IS NULL OR valid_from <= NOW())
      AND (valid_until IS NULL OR valid_until > NOW())
    ORDER BY LENGTH(prefix) DESC
    LIMIT 1
    `,
    [phone]
  );

  return rows[0] || null;
}

/**
 * একটি route-এর active provider candidate list দেয়।
 *
 * Priority ছোট হলে আগে চেষ্টা হবে।
 */
async function findRouteProviderCandidates(routeId) {
  const { rows } = await db.query(
    `
    SELECT
      vrp.id AS route_provider_id,
      vrp.route_id,
      vrp.provider_id,
      vrp.provider_plan_id,
      vrp.rate_card_id,
      vrp.priority,
      vrp.weight,
      vrp.allow_fallback,
      vrp.max_provider_rate_usd_min,
      COALESCE(
        vrp.platform_fee_usd_per_min,
        vpp.platform_fee_usd_per_min,
        vp.default_platform_fee_usd,
        0
      ) AS platform_fee_usd_per_min,

      vp.code AS provider_code,
      vp.name AS provider_name,
      vp.provider_type,
      vp.status AS provider_status,
      vp.supports_voice,

      vpp.code AS provider_plan_code,
      vpp.name AS provider_plan_name,
      vpp.plan_tier,
      COALESCE(vpp.discount_percent, 0) AS discount_percent,

      vprc.code AS rate_card_code,
      vprc.name AS rate_card_name,
      vprc.currency AS rate_card_currency,
      vprc.billing_increment_seconds,
      vprc.minimum_duration_seconds

    FROM voice_route_providers vrp
    JOIN voice_providers vp
      ON vp.id = vrp.provider_id

    LEFT JOIN voice_provider_plans vpp
      ON vpp.id = vrp.provider_plan_id

    LEFT JOIN voice_provider_rate_cards vprc
      ON vprc.id = vrp.rate_card_id

    WHERE vrp.route_id = $1
      AND vrp.is_active = TRUE
      AND vp.status = 'active'
      AND vp.supports_voice = TRUE

      AND (vrp.valid_from IS NULL OR vrp.valid_from <= NOW())
      AND (vrp.valid_until IS NULL OR vrp.valid_until > NOW())

      AND (
        vpp.id IS NULL
        OR (
          vpp.is_active = TRUE
          AND (vpp.valid_from IS NULL OR vpp.valid_from <= NOW())
          AND (vpp.valid_until IS NULL OR vpp.valid_until > NOW())
        )
      )

      AND (
        vprc.id IS NULL
        OR (
          vprc.is_active = TRUE
          AND (vprc.effective_from IS NULL OR vprc.effective_from <= NOW())
          AND (vprc.effective_until IS NULL OR vprc.effective_until > NOW())
        )
      )

    ORDER BY
      vrp.priority ASC,
      vrp.id ASC
    `,
    [routeId]
  );

  return rows;
}

/**
 * নির্দিষ্ট provider/rate card অনুযায়ী longest-prefix provider rate খুঁজে দেয়।
 */
async function findProviderRate({
  providerId,
  rateCardId,
  toPhoneE164,
}) {
  const phone = cleanPhone(toPhoneE164);

  if (!phone || !providerId) {
    return null;
  }

  const params = [providerId, phone];

  let rateCardFilter = "";

  if (rateCardId) {
    params.push(rateCardId);
    rateCardFilter = `AND vpr.rate_card_id = $3`;
  }

  const { rows } = await db.query(
    `
    SELECT
      vpr.id AS provider_rate_id,
      vpr.rate_card_id,
      vpr.provider_id,
      vpr.country_code,
      vpr.country_name,
      vpr.destination_name,
      vpr.prefix,
      vpr.raw_rate_usd_per_min,
      vpr.connection_fee_usd,
      COALESCE(
        vpr.billing_increment_seconds,
        vprc.billing_increment_seconds,
        60
      ) AS billing_increment_seconds,
      COALESCE(
        vpr.minimum_duration_seconds,
        vprc.minimum_duration_seconds,
        60
      ) AS minimum_duration_seconds,
      vpr.metadata,
      vprc.code AS rate_card_code,
      vprc.currency AS rate_card_currency
    FROM voice_provider_rates vpr
    JOIN voice_provider_rate_cards vprc
      ON vprc.id = vpr.rate_card_id
    WHERE vpr.provider_id = $1
      AND $2 LIKE vpr.prefix || '%'
      AND vpr.is_active = TRUE
      AND vprc.is_active = TRUE
      ${rateCardFilter}
      AND (vpr.effective_from IS NULL OR vpr.effective_from <= NOW())
      AND (vpr.effective_until IS NULL OR vpr.effective_until > NOW())
      AND (vprc.effective_from IS NULL OR vprc.effective_from <= NOW())
      AND (vprc.effective_until IS NULL OR vprc.effective_until > NOW())
    ORDER BY LENGTH(vpr.prefix) DESC
    LIMIT 1
    `,
    params
  );

  return rows[0] || null;
}

/**
 * Active manual customer rate override খুঁজে দেয়।
 *
 * Priority:
 * - longest matching prefix
 * - manual_override = TRUE
 *
 * Linked provider rate থাকলে Telnyx/provider billing interval,
 * minimum duration এবং connection fee-ও সঙ্গে return করবে।
 */
async function findManualOverrideRate(
  toPhoneE164
) {
  const phone = cleanPhone(
    toPhoneE164
  );

  if (!phone) {
    return null;
  }

  const { rows } = await db.query(
    `
    SELECT
      cr.id,
      cr.country_code,
      cr.country_name,
      cr.prefix,
      cr.currency,
      cr.price_per_min_cents,

      cr.provider,
      cr.provider_rate_usd_per_min,
      cr.sell_rate_usd_per_min,

      cr.markup_percent,
      cr.min_profit_usd_per_min,
      cr.manual_override,
      cr.rate_source,
      cr.last_synced_at,

      cr.is_active,
      cr.route_id,
      cr.provider_id,
      cr.provider_plan_id,
      cr.provider_rate_id,

      cr.platform_fee_usd_per_min,
      cr.discounted_provider_rate_usd_per_min,
      cr.max_provider_rate_usd_per_min,

      cr.publish_rate,
      cr.disabled_reason,

      COALESCE(
        vpr.connection_fee_usd,
        0
      ) AS connection_fee_usd,

      COALESCE(
        vpr.billing_increment_seconds,
        vprc.billing_increment_seconds,
        60
      ) AS billing_increment_seconds,

      COALESCE(
        vpr.minimum_duration_seconds,
        vprc.minimum_duration_seconds,
        60
      ) AS minimum_duration_seconds,

      vpr.destination_name,
      vpr.rate_card_id,
      vprc.code AS rate_card_code

    FROM call_rates cr

    LEFT JOIN voice_provider_rates vpr
      ON vpr.id =
         cr.provider_rate_id

    LEFT JOIN voice_provider_rate_cards vprc
      ON vprc.id =
         vpr.rate_card_id

    WHERE cr.is_active = TRUE
      AND cr.manual_override = TRUE
      AND cr.publish_rate = TRUE
      AND $1 LIKE cr.prefix || '%'

    ORDER BY
      LENGTH(cr.prefix) DESC,
      cr.id DESC

    LIMIT 1
    `,
    [phone]
  );

  return rows[0] || null;
}


/**
 * Existing automatic/legacy retail rate খুঁজে দেয়।
 *
 * Manual override এখানে return হবে না।
 * Manual override আলাদা priority resolver ব্যবহার করবে।
 */
async function findLegacyCallRate(
  toPhoneE164
) {
  const phone = cleanPhone(
    toPhoneE164
  );

  if (!phone) {
    return null;
  }

  const { rows } = await db.query(
    `
    SELECT
      cr.id,
      cr.country_code,
      cr.country_name,
      cr.prefix,
      cr.currency,
      cr.price_per_min_cents,

      cr.provider,
      cr.provider_rate_usd_per_min,
      cr.sell_rate_usd_per_min,

      cr.markup_percent,
      cr.min_profit_usd_per_min,
      cr.manual_override,
      cr.rate_source,
      cr.last_synced_at,

      cr.is_active,
      cr.route_id,
      cr.provider_id,
      cr.provider_plan_id,
      cr.provider_rate_id,

      cr.platform_fee_usd_per_min,
      cr.discounted_provider_rate_usd_per_min,
      cr.max_provider_rate_usd_per_min,

      cr.publish_rate,
      cr.disabled_reason,

      COALESCE(
        vpr.connection_fee_usd,
        0
      ) AS connection_fee_usd,

      COALESCE(
        vpr.billing_increment_seconds,
        vprc.billing_increment_seconds,
        60
      ) AS billing_increment_seconds,

      COALESCE(
        vpr.minimum_duration_seconds,
        vprc.minimum_duration_seconds,
        60
      ) AS minimum_duration_seconds,

      vpr.destination_name,
      vpr.rate_card_id,
      vprc.code AS rate_card_code

    FROM call_rates cr

    LEFT JOIN voice_provider_rates vpr
      ON vpr.id =
         cr.provider_rate_id

    LEFT JOIN voice_provider_rate_cards vprc
      ON vprc.id =
         vpr.rate_card_id

    WHERE cr.is_active = TRUE
      AND COALESCE(
        cr.manual_override,
        FALSE
      ) = FALSE

      AND cr.publish_rate = TRUE
      AND $1 LIKE cr.prefix || '%'

    ORDER BY
      LENGTH(cr.prefix) DESC,
      cr.id DESC

    LIMIT 1
    `,
    [phone]
  );

  return rows[0] || null;
}

module.exports = {
  cleanPhone,
  findDestinationPolicy,
  findActiveRoute,
  findRouteProviderCandidates,
  findProviderRate,
  findManualOverrideRate,
  findLegacyCallRate,
};