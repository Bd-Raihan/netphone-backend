const db = require("../../config/db");

const DEFAULT_MARKUP_PERCENT = 25;
const DEFAULT_MIN_PROFIT_USD_PER_MIN =
  0.002;

function round7(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Number(number.toFixed(7));
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

/**
 * Provider-rate metadata-এর category priority
 * safeভাবে numeric value-তে convert করবে।
 *
 * পুরোনো metadata-তে "0.01"-এর মতো decimal string
 * থাকলেও integer-cast error হবে না।
 */
const SAFE_CATEGORY_PRIORITY_SQL = `
  CASE
    WHEN (
      vpr.metadata
        #>>
      '{duplicate_preference,category_priority}'
    ) ~ '^[0-9]+$'
    THEN (
      vpr.metadata
        #>>
      '{duplicate_preference,category_priority}'
    )::integer

    WHEN LOWER(
      COALESCE(
        vpr.destination_name,
        ''
      )
    ) ~
    '(^|[^a-z])local([^a-z]|$)'
    THEN 100

    WHEN LOWER(
      COALESCE(
        vpr.destination_name,
        ''
      )
    ) ~
    '(^|[^a-z])(premium|special|satellite|shared cost|toll free)([^a-z]|$)'
    THEN 200

    ELSE 0
  END
`;

/**
 * Country Pricing Dashboard query।
 *
 * Master source:
 * voice_country_pricing_policies
 *
 * Provider selection:
 * 1. Existing active route-provider association
 * 2. Route provider priority
 * 3. General/applicable destination
 * 4. Lowest effective provider cost
 * 5. Lowest connection fee
 *
 * Route না থাকলেও active imported provider rate থেকে
 * country Dashboard-এ দেখাবে।
 */
const COUNTRY_PRICING_QUERY = `
  WITH country_pricing AS (
    SELECT
      vcpp.id AS country_pricing_policy_id,

      vcpp.country_code,
      vcpp.country_name,

      vcpp.representative_prefix
        AS prefix,

      vcpp.pricing_mode,
      vcpp.markup_percent,

      vcpp.manual_sell_rate_usd_per_min,

      vcpp.min_profit_usd_per_min,

      vcpp.is_enabled
        AS country_is_enabled,

      vcpp.publish_rate,

      vcpp.pricing_note
        AS manual_rate_note,

      vcpp.updated_by
        AS manual_rate_updated_by,

      vcpp.updated_at
        AS manual_rate_updated_at,

      route_data.route_id,
      route_data.route_code,
      route_data.route_name,
      route_data.route_is_active,

      provider_data.route_provider_id,

      provider_data.provider_id,
      provider_data.provider_code,
      provider_data.provider_name,
      provider_data.provider_type,

      provider_data.provider_plan_id,
      provider_data.provider_plan_code,

      provider_data.rate_card_id,
      provider_data.rate_card_code,

      provider_data.provider_rate_id,

      provider_data.provider_country_code,
      provider_data.provider_country_name,

      provider_data.provider_destination_name,
      provider_data.provider_prefix,

      provider_data.raw_provider_rate_usd_per_min,

      provider_data.discounted_provider_rate_usd_per_min,

      provider_data.platform_fee_usd_per_min,

      provider_data.total_provider_cost_usd_per_min,

      provider_data.connection_fee_usd,

      provider_data.billing_increment_seconds,

      provider_data.minimum_duration_seconds,

      provider_data.destination_rate_count,

      updater.phone_e164
        AS updated_by_phone

    FROM voice_country_pricing_policies vcpp

    /*
     * Country-এর existing logical route থাকলে
     * সেটি provider priority resolve করতে ব্যবহার হবে।
     */
    LEFT JOIN LATERAL (
      SELECT
        vr.id AS route_id,
        vr.code AS route_code,
        vr.name AS route_name,
        vr.is_active
          AS route_is_active

      FROM voice_routes vr

      WHERE vr.is_active = TRUE

        AND (
          UPPER(
            COALESCE(
              vr.country_code,
              ''
            )
          ) = vcpp.country_code

          OR vr.prefix =
             vcpp.representative_prefix
        )

        AND (
          vr.valid_from IS NULL
          OR vr.valid_from <= NOW()
        )

        AND (
          vr.valid_until IS NULL
          OR vr.valid_until > NOW()
        )

      ORDER BY
        CASE
          WHEN UPPER(
            COALESCE(
              vr.country_code,
              ''
            )
          ) = vcpp.country_code
          THEN 0
          ELSE 1
        END,

        LENGTH(vr.prefix) ASC,
        vr.id ASC

      LIMIT 1
    ) route_data
      ON TRUE

    /*
     * Multi-provider candidate নির্বাচন।
     *
     * Existing route-provider link থাকলে সেটির
     * priority আগে; route না থাকলে active imported
     * provider rates-এর মধ্যে applicable lowest cost।
     */
    LEFT JOIN LATERAL (
      SELECT
        selected_rate.route_provider_id,

        selected_rate.provider_id,
        selected_rate.provider_code,
        selected_rate.provider_name,
        selected_rate.provider_type,

        selected_rate.provider_plan_id,
        selected_rate.provider_plan_code,

        selected_rate.rate_card_id,
        selected_rate.rate_card_code,

        selected_rate.provider_rate_id,

        selected_rate.country_code
          AS provider_country_code,

        selected_rate.country_name
          AS provider_country_name,

        selected_rate.destination_name
          AS provider_destination_name,

        selected_rate.prefix
          AS provider_prefix,

        selected_rate.raw_rate_usd_per_min
          AS raw_provider_rate_usd_per_min,

        selected_rate.discounted_rate
          AS discounted_provider_rate_usd_per_min,

        selected_rate.platform_fee_usd_per_min,

        selected_rate.total_provider_cost
          AS total_provider_cost_usd_per_min,

        selected_rate.connection_fee_usd,

        selected_rate.billing_increment_seconds,

        selected_rate.minimum_duration_seconds,

        selected_rate.destination_rate_count

      FROM (
        SELECT
          vrp.id
            AS route_provider_id,

          vp.id
            AS provider_id,

          vp.code
            AS provider_code,

          vp.name
            AS provider_name,

          vp.provider_type,

          selected_plan.id
            AS provider_plan_id,

          selected_plan.code
            AS provider_plan_code,

          vprc.id
            AS rate_card_id,

          vprc.code
            AS rate_card_code,

          vpr.id
            AS provider_rate_id,

          vpr.country_code,
          vpr.country_name,
          vpr.destination_name,
          vpr.prefix,

          vpr.raw_rate_usd_per_min,

          COALESCE(
            selected_plan.discount_percent,
            0
          ) AS discount_percent,

          COALESCE(
            vrp.platform_fee_usd_per_min,

            selected_plan
              .platform_fee_usd_per_min,

            vp.default_platform_fee_usd,

            0
          ) AS platform_fee_usd_per_min,

          (
            vpr.raw_rate_usd_per_min
            *
            (
              1 -
              (
                COALESCE(
                  selected_plan.discount_percent,
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
                    selected_plan.discount_percent,
                    0
                  ) / 100.0
                )
              )
            )

            +

            COALESCE(
              vrp.platform_fee_usd_per_min,

              selected_plan
                .platform_fee_usd_per_min,

              vp.default_platform_fee_usd,

              0
            )
          ) AS total_provider_cost,

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

          COALESCE(
            vrp.priority,
            2147483647
          ) AS route_provider_priority,

          CASE
            WHEN vrp.id IS NULL
              THEN 1
            ELSE 0
          END AS route_link_priority,

          ${SAFE_CATEGORY_PRIORITY_SQL}
            AS destination_category_priority,

          COUNT(*) OVER (
            PARTITION BY
              vpr.provider_id,
              UPPER(vpr.country_code)
          )::integer
            AS destination_rate_count

        FROM voice_provider_rates vpr

        JOIN voice_provider_rate_cards vprc
          ON vprc.id =
             vpr.rate_card_id

        JOIN voice_providers vp
          ON vp.id =
             vpr.provider_id

        /*
         * Existing route-এর matching provider candidate।
         */
        LEFT JOIN LATERAL (
          SELECT
            candidate.*

          FROM voice_route_providers candidate

          WHERE route_data.route_id
                IS NOT NULL

            AND candidate.route_id =
                route_data.route_id

            AND candidate.provider_id =
                vpr.provider_id

            AND candidate.is_active = TRUE

            AND (
              candidate.rate_card_id
                IS NULL

              OR candidate.rate_card_id =
                 vpr.rate_card_id
            )

            AND (
              candidate.valid_from IS NULL
              OR candidate.valid_from <= NOW()
            )

            AND (
              candidate.valid_until IS NULL
              OR candidate.valid_until > NOW()
            )

          ORDER BY
            candidate.priority ASC,
            candidate.id ASC

          LIMIT 1
        ) vrp
          ON TRUE

        /*
         * Plan priority:
         * route-provider plan
         * → rate-card plan
         * → provider default active plan
         */
        LEFT JOIN LATERAL (
          SELECT
            vpp.id,
            vpp.code,
            vpp.discount_percent,
            vpp.platform_fee_usd_per_min

          FROM voice_provider_plans vpp

          WHERE vpp.provider_id =
                vpr.provider_id

            AND vpp.is_active = TRUE

            AND (
              vpp.valid_from IS NULL
              OR vpp.valid_from <= NOW()
            )

            AND (
              vpp.valid_until IS NULL
              OR vpp.valid_until > NOW()
            )

            AND (
              vpp.id =
                vrp.provider_plan_id

              OR vpp.id =
                vprc.provider_plan_id

              OR vpp.is_default = TRUE
            )

          ORDER BY
            CASE
              WHEN vpp.id =
                   vrp.provider_plan_id
                THEN 0

              WHEN vpp.id =
                   vprc.provider_plan_id
                THEN 1

              WHEN vpp.is_default = TRUE
                THEN 2

              ELSE 3
            END,

            vpp.id ASC

          LIMIT 1
        ) selected_plan
          ON TRUE

        WHERE vpr.is_active = TRUE
          AND vprc.is_active = TRUE

          AND vp.status = 'active'
          AND vp.supports_voice = TRUE

          AND UPPER(
            COALESCE(
              vpr.country_code,
              ''
            )
          ) = vcpp.country_code

          AND (
            vpr.effective_from IS NULL
            OR vpr.effective_from <= NOW()
          )

          AND (
            vpr.effective_until IS NULL
            OR vpr.effective_until > NOW()
          )

          AND (
            vprc.effective_from IS NULL
            OR vprc.effective_from <= NOW()
          )

          AND (
            vprc.effective_until IS NULL
            OR vprc.effective_until > NOW()
          )

          /*
           * Route থাকলে linked providers আগে।
           * Route না থাকলে সব active provider candidate।
           */
          AND (
            route_data.route_id IS NULL
            OR vrp.id IS NOT NULL
          )
      ) selected_rate

      ORDER BY
        selected_rate.route_link_priority ASC,

        selected_rate
          .route_provider_priority ASC,

        selected_rate
          .destination_category_priority ASC,

        selected_rate
          .total_provider_cost ASC,

        selected_rate
          .connection_fee_usd ASC,

        LENGTH(
          selected_rate.prefix
        ) DESC,

        selected_rate.provider_rate_id ASC

      LIMIT 1
    ) provider_data
      ON TRUE

    LEFT JOIN users updater
      ON updater.id =
         vcpp.updated_by
  )

  SELECT
    cp.country_pricing_policy_id,

    cp.route_id,

    COALESCE(
      cp.route_code,
      LOWER(cp.country_code)
        || '_country'
    ) AS route_code,

    COALESCE(
      cp.route_name,
      cp.country_name
    ) AS route_name,

    cp.country_code,
    cp.country_name,

    cp.prefix,

    cp.provider_code,
    cp.provider_name,
    cp.provider_type,

    cp.provider_plan_code,

    cp.provider_id,
    cp.provider_plan_id,

    cp.provider_rate_id,
    cp.route_provider_id,

    cp.rate_card_id,
    cp.rate_card_code,

    cp.raw_provider_rate_usd_per_min,

    cp.discounted_provider_rate_usd_per_min,

    cp.platform_fee_usd_per_min,

    cp.total_provider_cost_usd_per_min,

    cp.connection_fee_usd,

    cp.billing_increment_seconds,
    cp.minimum_duration_seconds,

    COALESCE(
      cp.destination_rate_count,
      0
    ) AS destination_rate_count,

    cp.pricing_mode,

    (
      cp.pricing_mode =
      'manual_rate'
    ) AS manual_override,

    cp.markup_percent,

    cp.manual_sell_rate_usd_per_min,

    CASE
      WHEN cp.pricing_mode =
           'manual_rate'
      THEN cp.manual_sell_rate_usd_per_min

      WHEN cp.total_provider_cost_usd_per_min
           IS NULL
      THEN NULL

      ELSE GREATEST(
        cp.total_provider_cost_usd_per_min
          *
          (
            1 +
            (
              cp.markup_percent /
              100.0
            )
          ),

        cp.total_provider_cost_usd_per_min
          +
          cp.min_profit_usd_per_min
      )
    END AS final_sell_rate_usd_per_min,

    cp.min_profit_usd_per_min,

    (
      cp.country_is_enabled = TRUE
      AND cp.publish_rate = TRUE
      AND cp.total_provider_cost_usd_per_min
          IS NOT NULL
    ) AS is_active,

    cp.publish_rate,

    cp.manual_rate_note,
    cp.manual_rate_updated_at,
    cp.manual_rate_updated_by,

    cp.updated_by_phone

  FROM country_pricing cp
`;

function mapPricingRow(row) {
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

    raw_provider_rate_usd_per_min:
      round7(
        row.raw_provider_rate_usd_per_min
      ),

    discounted_provider_rate_usd_per_min:
      round7(
        row
          .discounted_provider_rate_usd_per_min
      ),

    platform_fee_usd_per_min:
      round7(
        row.platform_fee_usd_per_min
      ),

    connection_fee_usd:
      round7(
        row.connection_fee_usd
      ),

    markup_percent:
      round7(
        row.markup_percent
      ),

    manual_sell_rate_usd_per_min:
      row.manual_sell_rate_usd_per_min ===
      null
        ? null
        : round7(
            row
              .manual_sell_rate_usd_per_min
          ),

    final_sell_rate_usd_per_min:
      round7(finalSellRate),

    min_profit_usd_per_min:
      round7(
        row.min_profit_usd_per_min
      ),

    profit_usd_per_min:
      round7(
        finalSellRate -
          providerCost
      ),

    effective_markup_percent:
      calculateMarkupPercent({
        providerCost,
        sellRate:
          finalSellRate,
      }),

    profit_margin_percent:
      calculateMarginPercent({
        providerCost,
        sellRate:
          finalSellRate,
      }),
  };
}

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
        $1 = ''

        OR LOWER(
          pricing.country_name
        ) LIKE '%' || $1 || '%'

        OR LOWER(
          pricing.country_code
        ) LIKE '%' || $1 || '%'

        OR pricing.prefix
           LIKE '%' || $1 || '%'

        OR LOWER(
          COALESCE(
            pricing.provider_name,
            ''
          )
        ) LIKE '%' || $1 || '%'
      )

      ORDER BY
        pricing.country_name ASC,
        pricing.country_code ASC
    `,
    [normalizedSearch]
  );

  return rows.map(mapPricingRow);
}

async function getCountryPricingByPrefix(
  prefix
) {
  const normalizedPrefix =
    String(prefix || "")
      .replace(/\D/g, "");

  if (!normalizedPrefix) {
    return null;
  }

  const { rows } = await db.query(
    `
      SELECT *
      FROM (
        ${COUNTRY_PRICING_QUERY}
      ) pricing

      WHERE pricing.prefix = $1

      ORDER BY
        pricing.country_name ASC

      LIMIT 1
    `,
    [normalizedPrefix]
  );

  if (!rows.length) {
    return null;
  }

  return mapPricingRow(rows[0]);
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
      reason:
        "country_route_not_found",
    };
  }

  const providerCost =
    Number(
      current
        .provider_cost_usd_per_min ||
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

  const pricingMode =
    String(
      payload.pricing_mode || ""
    )
      .trim()
      .toLowerCase();

  const client =
    await db.getClient();

  try {
    await client.query("BEGIN");

    /*
     * পুরোনো prefix-level manual override যেন
     * নতুন country policy-কে bypass না করে।
     */
    await client.query(
      `
        UPDATE call_rates
        SET
          manual_override = FALSE,

          pricing_mode =
            'auto_markup',

          rate_source =
            'country_pricing_v2',

          manual_rate_updated_by = $2,

          manual_rate_updated_at =
            NOW(),

          updated_at = NOW()

        WHERE UPPER(
          COALESCE(
            country_code,
            ''
          )
        ) = $1

          AND COALESCE(
            manual_override,
            FALSE
          ) = TRUE
      `,
      [
        current.country_code,
        adminUserId,
      ]
    );

    if (
      pricingMode ===
      "auto_markup"
    ) {
      const markupPercent =
        Number(
          payload.markup_percent
        );

      await client.query(
        `
          UPDATE
            voice_country_pricing_policies

          SET
            pricing_mode =
              'auto_markup',

            markup_percent = $2,

            manual_sell_rate_usd_per_min =
              NULL,

            is_enabled =
              COALESCE(
                $3,
                is_enabled
              ),

            publish_rate =
              COALESCE(
                $3,
                publish_rate
              ),

            pricing_note = $4,

            updated_by = $5,

            updated_at = NOW()

          WHERE country_code = $1
        `,
        [
          current.country_code,
          markupPercent,
          payload.is_active,
          payload.note,
          adminUserId,
        ]
      );
    } else if (
      pricingMode ===
      "manual_rate"
    ) {
      const manualSellRate =
        Number(
          payload
            .manual_sell_rate_usd_per_min
        );

      if (
        !Number.isFinite(
          manualSellRate
        ) ||
        manualSellRate <= providerCost
      ) {
        await client.query(
          "ROLLBACK"
        );

        return {
          ok: false,

          reason:
            "manual_rate_not_above_provider_cost",

          provider_cost_usd_per_min:
            round7(providerCost),

          minimum_allowed_rate:
            round7(
              providerCost +
                0.0000001
            ),
        };
      }

      const effectiveMarkup =
        calculateMarkupPercent({
          providerCost,
          sellRate:
            manualSellRate,
        });

      await client.query(
        `
          UPDATE
            voice_country_pricing_policies

          SET
            pricing_mode =
              'manual_rate',

            markup_percent = $2,

            manual_sell_rate_usd_per_min =
              $3,

            is_enabled =
              COALESCE(
                $4,
                is_enabled
              ),

            publish_rate =
              COALESCE(
                $4,
                publish_rate
              ),

            pricing_note = $5,

            updated_by = $6,

            updated_at = NOW()

          WHERE country_code = $1
        `,
        [
          current.country_code,
          effectiveMarkup,
          round7(manualSellRate),
          payload.is_active,
          payload.note,
          adminUserId,
        ]
      );
    } else {
      await client.query(
        "ROLLBACK"
      );

      return {
        ok: false,
        reason:
          "unsupported_pricing_mode",
      };
    }

    await client.query("COMMIT");

    return {
      ok: true,
      pricing_mode:
        pricingMode,

      data:
        await getCountryPricingByPrefix(
          prefix
        ),
    };
  } catch (error) {
    try {
      await client.query(
        "ROLLBACK"
      );
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
  const current =
    await getCountryPricingByPrefix(
      prefix
    );

  if (!current) {
    return {
      ok: false,
      reason:
        "pricing_record_not_found",
    };
  }

  const result =
    await db.query(
      `
        UPDATE
          voice_country_pricing_policies

        SET
          pricing_mode =
            'auto_markup',

          manual_sell_rate_usd_per_min =
            NULL,

          pricing_note =
            'Manual rate disabled by Admin',

          updated_by = $2,

          updated_at = NOW()

        WHERE country_code = $1

        RETURNING id
      `,
      [
        current.country_code,
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

  /*
   * পুরোনো prefix-level override-ও বন্ধ হবে।
   */
  await db.query(
    `
      UPDATE call_rates
      SET
        manual_override = FALSE,

        pricing_mode =
          'auto_markup',

        rate_source =
          'country_pricing_v2',

        manual_rate_updated_by = $2,

        manual_rate_updated_at =
          NOW(),

        updated_at = NOW()

      WHERE UPPER(
        COALESCE(
          country_code,
          ''
        )
      ) = $1
    `,
    [
      current.country_code,
      adminUserId,
    ]
  );

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