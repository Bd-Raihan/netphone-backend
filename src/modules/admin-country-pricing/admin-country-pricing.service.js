const db = require("../../config/db");

const DEFAULT_MARKUP_PERCENT = 25;
const DEFAULT_MIN_PROFIT_USD_PER_MIN =
  0.002;

function round7(value) {
  return Number(
    Number(value || 0).toFixed(7)
  );
}

function calculateMarkupPercent({
  providerCost,
  sellRate,
}) {
  const cost = Number(providerCost);
  const sell = Number(sellRate);

  if (
    !Number.isFinite(cost) ||
    cost <= 0 ||
    !Number.isFinite(sell) ||
    sell <= 0
  ) {
    return 0;
  }

  return round7(
    ((sell - cost) / cost) * 100
  );
}

function calculateMarginPercent({
  providerCost,
  sellRate,
}) {
  const cost = Number(providerCost);
  const sell = Number(sellRate);

  if (
    !Number.isFinite(cost) ||
    cost < 0 ||
    !Number.isFinite(sell) ||
    sell <= 0
  ) {
    return 0;
  }

  return round7(
    ((sell - cost) / sell) * 100
  );
}

/*
 * একটি active route/country-এর জন্য:
 *
 * - Active provider/plan/rate-card resolve করে
 * - Route prefix-এর অন্তর্ভুক্ত highest provider cost নেয়
 * - Existing manual override যুক্ত করে
 *
 * Highest cost নেওয়ার কারণ:
 * Country-wide manual rate যেন কোনো sub-prefix-এ
 * provider cost-এর নিচে না যায়।
 */
const COUNTRY_PRICING_QUERY = `
  WITH route_data AS (
    SELECT
      vr.id AS route_id,
      vr.code AS route_code,
      vr.name AS route_name,
      vr.country_code,
      vr.prefix,
      vr.is_active AS route_is_active,

      COALESCE(
        vr.markup_percent,
        vdp.markup_percent,
        $1::numeric
      ) AS route_markup_percent,

      COALESCE(
        vr.min_profit_usd_per_min,
        vdp.min_profit_usd_per_min,
        $2::numeric
      ) AS min_profit_usd_per_min,

      vdp.destination_name,
      vdp.is_enabled
        AS destination_is_enabled,

      vdp.publish_rates
        AS destination_publish_rates,

      provider_route.route_provider_id,
      provider_route.provider_id,
      provider_route.provider_plan_id,
      provider_route.rate_card_id,

      provider_route.provider_code,
      provider_route.provider_name,
      provider_route.provider_plan_code,

      provider_route.discount_percent,
      provider_route.platform_fee_usd_per_min,

      provider_cost.provider_rate_id,
      provider_cost.provider_country_code,
      provider_cost.provider_country_name,
      provider_cost.provider_destination_name,
      provider_cost.provider_prefix,
      provider_cost.raw_provider_rate_usd_per_min,

      provider_cost.discounted_provider_rate_usd_per_min,

      provider_cost.total_provider_cost_usd_per_min,

      provider_cost.billing_increment_seconds,
      provider_cost.minimum_duration_seconds,
      provider_cost.connection_fee_usd,

      provider_cost.destination_rate_count

    FROM voice_routes vr

    LEFT JOIN voice_destination_policies vdp
      ON vdp.prefix = vr.prefix

    LEFT JOIN LATERAL (
      SELECT
        vrp.id AS route_provider_id,
        vrp.provider_id,
        vrp.provider_plan_id,
        vrp.rate_card_id,

        vp.code AS provider_code,
        vp.name AS provider_name,

        vpp.code AS provider_plan_code,

        COALESCE(
          vpp.discount_percent,
          0
        ) AS discount_percent,

        COALESCE(
          vrp.platform_fee_usd_per_min,
          vpp.platform_fee_usd_per_min,
          vp.default_platform_fee_usd,
          0
        ) AS platform_fee_usd_per_min

      FROM voice_route_providers vrp

      JOIN voice_providers vp
        ON vp.id = vrp.provider_id

      LEFT JOIN voice_provider_plans vpp
        ON vpp.id =
           vrp.provider_plan_id

      LEFT JOIN voice_provider_rate_cards vprc
        ON vprc.id =
           vrp.rate_card_id

      WHERE vrp.route_id = vr.id
        AND vrp.is_active = TRUE
        AND vp.status = 'active'
        AND vp.supports_voice = TRUE

        AND (
          vpp.id IS NULL
          OR vpp.is_active = TRUE
        )

        AND (
          vprc.id IS NULL
          OR vprc.is_active = TRUE
        )

        AND (
          vrp.valid_from IS NULL
          OR vrp.valid_from <= NOW()
        )

        AND (
          vrp.valid_until IS NULL
          OR vrp.valid_until > NOW()
        )

      ORDER BY
        vrp.priority ASC,
        vrp.id ASC

      LIMIT 1
    ) provider_route
      ON TRUE

    LEFT JOIN LATERAL (
      SELECT
        highest_rate.provider_rate_id,
        highest_rate.country_code
          AS provider_country_code,

        highest_rate.country_name
          AS provider_country_name,

        highest_rate.destination_name
          AS provider_destination_name,

        highest_rate.prefix
          AS provider_prefix,

        highest_rate.raw_rate_usd_per_min
          AS raw_provider_rate_usd_per_min,

        highest_rate.discounted_rate
          AS discounted_provider_rate_usd_per_min,

        highest_rate.total_provider_cost
          AS total_provider_cost_usd_per_min,

        highest_rate.billing_increment_seconds,
        highest_rate.minimum_duration_seconds,
        highest_rate.connection_fee_usd,

        rate_count.destination_rate_count

      FROM (
        SELECT
          vpr.id AS provider_rate_id,
          vpr.country_code,
          vpr.country_name,
          vpr.destination_name,
          vpr.prefix,
          vpr.raw_rate_usd_per_min,

          (
            vpr.raw_rate_usd_per_min
            *
            (
              1 -
              (
                COALESCE(
                  provider_route.discount_percent,
                  0
                ) / 100.0
              )
            )
          ) AS discounted_rate,

          (
            (
              vpr.raw_rate_usd_per_min
              *
              (
                1 -
                (
                  COALESCE(
                    provider_route.discount_percent,
                    0
                  ) / 100.0
                )
              )
            )
            +
            COALESCE(
              provider_route
                .platform_fee_usd_per_min,
              0
            )
          ) AS total_provider_cost,

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

          COALESCE(
            vpr.connection_fee_usd,
            0
          ) AS connection_fee_usd

        FROM voice_provider_rates vpr

        JOIN voice_provider_rate_cards vprc
          ON vprc.id =
             vpr.rate_card_id

        WHERE vpr.provider_id =
              provider_route.provider_id

          AND (
            provider_route.rate_card_id
              IS NULL
            OR vpr.rate_card_id =
               provider_route.rate_card_id
          )

          AND vpr.is_active = TRUE
          AND vprc.is_active = TRUE

          AND vpr.prefix
              LIKE vr.prefix || '%'

          AND (
            vpr.effective_from IS NULL
            OR vpr.effective_from <= NOW()
          )

          AND (
            vpr.effective_until IS NULL
            OR vpr.effective_until > NOW()
          )

        ORDER BY
          total_provider_cost DESC,
          LENGTH(vpr.prefix) DESC,
          vpr.id ASC

        LIMIT 1
      ) highest_rate

      CROSS JOIN LATERAL (
        SELECT
          COUNT(*)::int
            AS destination_rate_count

        FROM voice_provider_rates counted_rate

        JOIN voice_provider_rate_cards counted_card
          ON counted_card.id =
             counted_rate.rate_card_id

        WHERE counted_rate.provider_id =
              provider_route.provider_id

          AND (
            provider_route.rate_card_id
              IS NULL
            OR counted_rate.rate_card_id =
               provider_route.rate_card_id
          )

          AND counted_rate.is_active = TRUE
          AND counted_card.is_active = TRUE

          AND counted_rate.prefix
              LIKE vr.prefix || '%'
      ) rate_count
    ) provider_cost
      ON TRUE

    WHERE vr.is_active = TRUE
  )

  SELECT
    rd.route_id,
    rd.route_code,
    rd.route_name,

    COALESCE(
      NULLIF(rd.country_code, ''),
      NULLIF(rd.provider_country_code, ''),
      'UNKNOWN'
    ) AS country_code,

    COALESCE(
      NULLIF(rd.provider_country_name, ''),
      NULLIF(rd.destination_name, ''),
      NULLIF(rd.route_name, ''),
      'Unknown'
    ) AS country_name,

    rd.prefix,

    rd.provider_code,
    rd.provider_name,
    rd.provider_plan_code,

    rd.provider_id,
    rd.provider_plan_id,
    rd.provider_rate_id,
    rd.route_provider_id,

    rd.raw_provider_rate_usd_per_min,

    rd.discounted_provider_rate_usd_per_min,

    rd.platform_fee_usd_per_min,

    rd.total_provider_cost_usd_per_min,

    rd.billing_increment_seconds,
    rd.minimum_duration_seconds,
    rd.connection_fee_usd,
    rd.destination_rate_count,

    COALESCE(
      cr.pricing_mode,
      CASE
        WHEN COALESCE(
          cr.manual_override,
          FALSE
        ) = TRUE
          THEN 'manual_rate'
        ELSE 'auto_markup'
      END
    ) AS pricing_mode,

    COALESCE(
      cr.manual_override,
      FALSE
    ) AS manual_override,

    COALESCE(
      CASE
        WHEN COALESCE(
          cr.manual_override,
          FALSE
        ) = TRUE
          THEN cr.markup_percent
        ELSE rd.route_markup_percent
      END,
      $1::numeric
    ) AS markup_percent,

    cr.sell_rate_usd_per_min
      AS manual_sell_rate_usd_per_min,

    CASE
      WHEN COALESCE(
        cr.manual_override,
        FALSE
      ) = TRUE
      THEN cr.sell_rate_usd_per_min

      ELSE GREATEST(
        rd.total_provider_cost_usd_per_min
          *
          (
            1 +
            (
              COALESCE(
                rd.route_markup_percent,
                $1::numeric
              ) / 100.0
            )
          ),

        rd.total_provider_cost_usd_per_min
          +
          COALESCE(
            rd.min_profit_usd_per_min,
            $2::numeric
          )
      )
    END AS final_sell_rate_usd_per_min,

    rd.min_profit_usd_per_min,

    COALESCE(
      cr.is_active,
      rd.route_is_active
    ) AS is_active,

    COALESCE(
      cr.publish_rate,
      rd.destination_publish_rates,
      TRUE
    ) AS publish_rate,

    cr.manual_rate_note,
    cr.manual_rate_updated_at,
    cr.manual_rate_updated_by,

    updater.phone_e164
      AS updated_by_phone

  FROM route_data rd

  LEFT JOIN call_rates cr
    ON cr.prefix = rd.prefix

  LEFT JOIN users updater
    ON updater.id =
       cr.manual_rate_updated_by
`;

async function listCountryPricing({
  search = "",
} = {}) {
  const normalizedSearch =
    String(search || "")
      .trim()
      .toLowerCase();

  const { rows } = await db.query(
    `
      SELECT *
      FROM (
        ${COUNTRY_PRICING_QUERY}
      ) pricing

      WHERE (
        $3 = ''
        OR LOWER(pricing.country_name)
           LIKE '%' || $3 || '%'
        OR LOWER(pricing.country_code)
           LIKE '%' || $3 || '%'
        OR pricing.prefix
           LIKE '%' || $3 || '%'
      )

      ORDER BY
        pricing.country_name ASC,
        LENGTH(pricing.prefix) ASC,
        pricing.prefix ASC
    `,
    [
      DEFAULT_MARKUP_PERCENT,
      DEFAULT_MIN_PROFIT_USD_PER_MIN,
      normalizedSearch,
    ]
  );

  return rows.map((row) => {
    const providerCost =
      Number(
        row.total_provider_cost_usd_per_min ||
        0
      );

    const finalSellRate =
      Number(
        row.final_sell_rate_usd_per_min ||
        0
      );

    return {
      ...row,

      provider_cost_usd_per_min:
        round7(providerCost),

      final_sell_rate_usd_per_min:
        round7(finalSellRate),

      profit_usd_per_min:
        round7(
          finalSellRate - providerCost
        ),

      effective_markup_percent:
        calculateMarkupPercent({
          providerCost,
          sellRate: finalSellRate,
        }),

      profit_margin_percent:
        calculateMarginPercent({
          providerCost,
          sellRate: finalSellRate,
        }),
    };
  });
}

async function getCountryPricingByPrefix(
  prefix
) {
  const { rows } = await db.query(
    `
      SELECT *
      FROM (
        ${COUNTRY_PRICING_QUERY}
      ) pricing
      WHERE pricing.prefix = $3
      LIMIT 1
    `,
    [
      DEFAULT_MARKUP_PERCENT,
      DEFAULT_MIN_PROFIT_USD_PER_MIN,
      prefix,
    ]
  );

  const row = rows[0];

  if (!row) {
    return null;
  }

  const providerCost =
    Number(
      row.total_provider_cost_usd_per_min ||
      0
    );

  const finalSellRate =
    Number(
      row.final_sell_rate_usd_per_min ||
      0
    );

  return {
    ...row,

    provider_cost_usd_per_min:
      round7(providerCost),

    final_sell_rate_usd_per_min:
      round7(finalSellRate),

    profit_usd_per_min:
      round7(
        finalSellRate - providerCost
      ),

    effective_markup_percent:
      calculateMarkupPercent({
        providerCost,
        sellRate: finalSellRate,
      }),

    profit_margin_percent:
      calculateMarginPercent({
        providerCost,
        sellRate: finalSellRate,
      }),
  };
}

async function updateCountryPricing({
  prefix,
  adminUserId,
  payload,
}) {
  const current =
    await getCountryPricingByPrefix(
      prefix
    );

  if (!current) {
    return {
      ok: false,
      reason: "country_route_not_found",
    };
  }

  const providerCost =
    Number(
      current.provider_cost_usd_per_min ||
      0
    );

  if (
    !Number.isFinite(providerCost) ||
    providerCost <= 0
  ) {
    return {
      ok: false,
      reason:
        "provider_cost_not_available",
    };
  }

  const client =
    await db.getClient();

  try {
    await client.query("BEGIN");

    const countryCode =
      payload.country_code ||
      current.country_code;

    const countryName =
      current.country_name ||
      current.route_name ||
      "Unknown";

    const activeValue =
      payload.is_active === null
        ? true
        : payload.is_active;

    if (
      payload.pricing_mode ===
      "auto_markup"
    ) {
      const markupPercent =
        Number(
          payload.markup_percent
        );

      const minimumProfit =
        Number(
          current.min_profit_usd_per_min ||
          DEFAULT_MIN_PROFIT_USD_PER_MIN
        );

      const calculatedSellRate =
        Math.max(
          providerCost *
            (
              1 +
              markupPercent / 100
            ),

          providerCost +
            minimumProfit
        );

      /*
       * Auto mode-এ route markup authoritative।
       * Provider cost বদলালে Router নতুন rate
       * স্বয়ংক্রিয়ভাবে calculate করবে।
       */
      await client.query(
        `
          UPDATE voice_routes
          SET
            markup_percent = $2,
            updated_at = NOW()
          WHERE prefix = $1
        `,
        [
          prefix,
          markupPercent,
        ]
      );

      /*
       * Existing manual override থাকলে disable হবে।
       * Row delete করা হবে না—history/config থাকবে।
       */
      await client.query(
        `
          UPDATE call_rates
          SET
            country_code = $2,
            country_name = $3,

            pricing_mode =
              'auto_markup',

            manual_override = FALSE,

            markup_percent = $4,

            sell_rate_usd_per_min = $5,

            price_per_min_cents =
              GREATEST(
                1,
                CEIL($5 * 100)::integer
              ),

            rate_source =
              'admin_auto_markup',

            is_active = $6,
            publish_rate = $6,

            manual_rate_note = $7,

            manual_rate_updated_by = $8,

            manual_rate_updated_at =
              NOW(),

            updated_at = NOW()

          WHERE prefix = $1
        `,
        [
          prefix,
          countryCode,
          countryName,
          markupPercent,
          round7(calculatedSellRate),
          activeValue,
          payload.note,
          adminUserId,
        ]
      );

      await client.query("COMMIT");

      return {
        ok: true,
        pricing_mode:
          "auto_markup",

        data:
          await getCountryPricingByPrefix(
            prefix
          ),
      };
    }

    const manualSellRate =
      Number(
        payload
          .manual_sell_rate_usd_per_min
      );

    if (
      manualSellRate <= providerCost
    ) {
      await client.query("ROLLBACK");

      return {
        ok: false,

        reason:
          "manual_rate_not_above_provider_cost",

        provider_cost_usd_per_min:
          round7(providerCost),

        minimum_allowed_rate:
          round7(
            providerCost + 0.0000001
          ),
      };
    }

    const markupPercent =
      calculateMarkupPercent({
        providerCost,
        sellRate: manualSellRate,
      });

    const discountedProviderRate =
      Number(
        current
          .discounted_provider_rate_usd_per_min ||
        current
          .raw_provider_rate_usd_per_min ||
        providerCost
      );

    const platformFee =
      Number(
        current
          .platform_fee_usd_per_min ||
        0
      );

    await client.query(
      `
        INSERT INTO call_rates (
          country_code,
          country_name,
          prefix,

          currency,
          price_per_min_cents,

          is_active,

          provider,
          provider_rate_usd_per_min,

          discounted_provider_rate_usd_per_min,

          platform_fee_usd_per_min,

          sell_rate_usd_per_min,

          markup_percent,
          min_profit_usd_per_min,

          manual_override,
          rate_source,

          route_id,
          provider_id,
          provider_plan_id,
          provider_rate_id,

          publish_rate,
          disabled_reason,

          pricing_mode,

          manual_rate_note,
          manual_rate_updated_by,
          manual_rate_updated_at,

          last_synced_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,

          'USD',
          GREATEST(
            1,
            CEIL($4 * 100)::integer
          ),

          $5,

          COALESCE($6, 'telnyx'),
          $7,

          $8,
          $9,

          $4,

          $10,
          $11,

          TRUE,
          'admin_manual_rate',

          $12,
          $13,
          $14,
          $15,

          $5,
          CASE
            WHEN $5 = TRUE
              THEN NULL
            ELSE
              'Disabled by Admin'
          END,

          'manual_rate',

          $16,
          $17,
          NOW(),

          NOW(),
          NOW()
        )

        ON CONFLICT (prefix)
        DO UPDATE SET
          country_code =
            EXCLUDED.country_code,

          country_name =
            EXCLUDED.country_name,

          currency = 'USD',

          price_per_min_cents =
            EXCLUDED.price_per_min_cents,

          is_active =
            EXCLUDED.is_active,

          provider =
            EXCLUDED.provider,

          provider_rate_usd_per_min =
            EXCLUDED
              .provider_rate_usd_per_min,

          discounted_provider_rate_usd_per_min =
            EXCLUDED
              .discounted_provider_rate_usd_per_min,

          platform_fee_usd_per_min =
            EXCLUDED
              .platform_fee_usd_per_min,

          sell_rate_usd_per_min =
            EXCLUDED
              .sell_rate_usd_per_min,

          markup_percent =
            EXCLUDED.markup_percent,

          min_profit_usd_per_min =
            EXCLUDED
              .min_profit_usd_per_min,

          manual_override = TRUE,

          rate_source =
            'admin_manual_rate',

          route_id =
            EXCLUDED.route_id,

          provider_id =
            EXCLUDED.provider_id,

          provider_plan_id =
            EXCLUDED.provider_plan_id,

          provider_rate_id =
            EXCLUDED.provider_rate_id,

          publish_rate =
            EXCLUDED.publish_rate,

          disabled_reason =
            EXCLUDED.disabled_reason,

          pricing_mode =
            'manual_rate',

          manual_rate_note =
            EXCLUDED.manual_rate_note,

          manual_rate_updated_by =
            EXCLUDED
              .manual_rate_updated_by,

          manual_rate_updated_at =
            NOW(),

          last_synced_at =
            NOW(),

          updated_at =
            NOW()
      `,
      [
        countryCode,
        countryName,
        prefix,

        round7(manualSellRate),
        activeValue,

        current.provider_code,

        Number(
          current
            .raw_provider_rate_usd_per_min ||
          providerCost
        ),

        discountedProviderRate,
        platformFee,

        markupPercent,

        Number(
          current
            .min_profit_usd_per_min ||
          DEFAULT_MIN_PROFIT_USD_PER_MIN
        ),

        current.route_id,
        current.provider_id,
        current.provider_plan_id,
        current.provider_rate_id,

        payload.note,
        adminUserId,
      ]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      pricing_mode:
        "manual_rate",

      data:
        await getCountryPricingByPrefix(
          prefix
        ),
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // Original error preserve হবে।
    }

    throw error;
  } finally {
    client.release();
  }
}

async function disableManualOverride({
  prefix,
  adminUserId,
}) {
  const result =
    await db.query(
      `
        UPDATE call_rates
        SET
          pricing_mode =
            'auto_markup',

          manual_override = FALSE,

          rate_source =
            'admin_manual_override_disabled',

          manual_rate_updated_by = $2,

          manual_rate_updated_at =
            NOW(),

          updated_at =
            NOW()

        WHERE prefix = $1

        RETURNING id
      `,
      [
        prefix,
        adminUserId,
      ]
    );

  if (!result.rows.length) {
    return {
      ok: false,
      reason:
        "pricing_record_not_found",
    };
  }

  return {
    ok: true,

    data:
      await getCountryPricingByPrefix(
        prefix
      ),
  };
}

module.exports = {
  listCountryPricing,
  getCountryPricingByPrefix,
  updateCountryPricing,
  disableManualOverride,
};