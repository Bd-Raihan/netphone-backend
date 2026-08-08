"use strict";

const db = require("../../config/db");

// ============================================================
// 🇧🇩 ADMIN CALL ACTIVITY / CDR REPORT SERVICE
//
// কাজ:
// - শুধুমাত্র existing call_sessions ও users table READ করবে
// - Calling Engine পরিবর্তন করবে না
// - Billing পরিবর্তন করবে না
// - Wallet পরিবর্তন করবে না
// - Profit calculation পরিবর্তন করবে না
//
// এই module Admin investigation / CDR report-এর জন্য।
// ============================================================

function normalizePositiveInteger(
  value,
  fallback,
  {
    min = 1,
    max = Number.MAX_SAFE_INTEGER,
  } = {}
) {
  const parsed =
    Number.parseInt(
      String(value ?? ""),
      10
    );

  if (
    !Number.isInteger(parsed) ||
    parsed < min
  ) {
    return fallback;
  }

  return Math.min(
    parsed,
    max
  );
}

function normalizeText(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  return String(value)
    .trim();
}

function normalizeDate(value) {
  const text =
    normalizeText(value);

  if (!text) {
    return null;
  }

  const parsed =
    new Date(text);

  if (
    Number.isNaN(
      parsed.getTime()
    )
  ) {
    return null;
  }

  return parsed;
}

/**
 * ============================================================
 * 🇧🇩 ADMIN CDR FILTER BUILDER
 *
 * User input সরাসরি SQL-এ বসানো হয় না।
 * সব filter parameterized query ব্যবহার করে।
 * ============================================================
 */
function buildFilters(filters = {}) {
  const conditions = [];
  const values = [];

  const addValue = (value) => {
    values.push(value);
    return `$${values.length}`;
  };

  const search =
    normalizeText(
      filters.search
    );

  const registeredNumber =
    normalizeText(
      filters.registeredNumber
    );

  const destinationNumber =
    normalizeText(
      filters.destinationNumber
    );

  const destinationCountry =
    normalizeText(
      filters.destinationCountry
    );

  const originCountry =
    normalizeText(
      filters.originCountry
    );

  const status =
    normalizeText(
      filters.status
    );

  const provider =
    normalizeText(
      filters.provider
    );

  const fromDate =
    normalizeDate(
      filters.fromDate
    );

  const toDate =
    normalizeDate(
      filters.toDate
    );

  if (search) {
    const placeholder =
      addValue(
        `%${search}%`
      );

    conditions.push(`
      (
        COALESCE(
          u.phone_e164,
          ''
        ) ILIKE ${placeholder}

        OR

        COALESCE(
          cs.to_phone_e164,
          ''
        ) ILIKE ${placeholder}

        OR

        CAST(
          cs.id AS TEXT
        ) ILIKE ${placeholder}
      )
    `);
  }

  if (registeredNumber) {
    const placeholder =
      addValue(
        `%${registeredNumber}%`
      );

    conditions.push(`
      COALESCE(
        u.phone_e164,
        ''
      ) ILIKE ${placeholder}
    `);
  }

  if (destinationNumber) {
    const placeholder =
      addValue(
        `%${destinationNumber}%`
      );

    conditions.push(`
      COALESCE(
        cs.to_phone_e164,
        ''
      ) ILIKE ${placeholder}
    `);
  }

  if (destinationCountry) {
    const placeholder =
      addValue(
        `%${destinationCountry}%`
      );

    conditions.push(`
      COALESCE(
        NULLIF(
          destination_rate.country_name,
          ''
        ),

        NULLIF(
          legacy_rate.country_name,
          ''
        ),

        NULLIF(
          cs.meta #>>
            '{pricing_snapshot,country_name}',
          ''
        ),

        'Unknown'
      ) ILIKE ${placeholder}
    `);
  }

  if (originCountry) {
    const placeholder =
      addValue(
        `%${originCountry}%`
      );

    conditions.push(`
      COALESCE(
        NULLIF(
          origin_rate.country_name,
          ''
        ),

        NULLIF(
          u.country_code,
          ''
        ),

        'Unknown'
      ) ILIKE ${placeholder}
    `);
  }

  if (status) {
    const placeholder =
      addValue(
        status.toLowerCase()
      );

    conditions.push(`
      LOWER(
        COALESCE(
          cs.status,
          ''
        )
      ) = ${placeholder}
    `);
  }

  if (provider) {
    const placeholder =
      addValue(
        provider.toLowerCase()
      );

    conditions.push(`
      LOWER(
        COALESCE(
          cs.provider,
          ''
        )
      ) = ${placeholder}
    `);
  }

  if (fromDate) {
    const placeholder =
      addValue(
        fromDate.toISOString()
      );

    conditions.push(`
      cs.started_at >=
        ${placeholder}::timestamptz
    `);
  }

  if (toDate) {
    const placeholder =
      addValue(
        toDate.toISOString()
      );

    conditions.push(`
      cs.started_at <=
        ${placeholder}::timestamptz
    `);
  }

  return {
    whereSql:
      conditions.length
        ? `WHERE ${conditions.join(
            "\nAND "
          )}`
        : "",

    values,
  };
}

/**
 * ============================================================
 * 🇧🇩 COMMON CDR JOIN
 *
 * Registered user country এবং destination country resolve করে।
 * Existing production data-ই ব্যবহার করা হচ্ছে।
 * ============================================================
 */
const commonJoinSql = `
  FROM call_sessions cs

  INNER JOIN users u
    ON u.id = cs.user_id

  LEFT JOIN voice_provider_rates
    destination_rate
    ON destination_rate.id =
       cs.provider_rate_id

  LEFT JOIN call_rates
    legacy_rate
    ON legacy_rate.id =
       cs.rate_id

  LEFT JOIN LATERAL (
    SELECT
      r.country_name,
      r.country_code

    FROM voice_provider_rates r

    WHERE
      REPLACE(
        COALESCE(
          u.phone_e164,
          ''
        ),
        '+',
        ''
      )
      LIKE
      REPLACE(
        COALESCE(
          r.prefix,
          ''
        ),
        '+',
        ''
      ) || '%'

    ORDER BY
      LENGTH(
        REPLACE(
          COALESCE(
            r.prefix,
            ''
          ),
          '+',
          ''
        )
      ) DESC,

      r.id ASC

    LIMIT 1
  ) origin_rate
    ON TRUE
`;

/**
 * ============================================================
 * 🇧🇩 CALL ACTIVITY LIST
 *
 * Main Admin CDR table-এর data return করে।
 * ============================================================
 */
async function getCallActivityList(
  filters = {}
) {
  const limit =
    normalizePositiveInteger(
      filters.limit,
      50,
      {
        min: 1,
        max: 200,
      }
    );

  const offset =
    normalizePositiveInteger(
      filters.offset,
      0,
      {
        min: 0,
        max: 10_000_000,
      }
    );

  const {
    whereSql,
    values,
  } =
    buildFilters(filters);

  const limitPlaceholder =
    `$${values.length + 1}`;

  const offsetPlaceholder =
    `$${values.length + 2}`;

  const queryValues = [
    ...values,
    limit,
    offset,
  ];

  const result =
    await db.query(
      `
        SELECT
          cs.id
            AS call_id,

          cs.user_id,

          u.phone_e164
            AS registered_number,

          COALESCE(
            NULLIF(
              origin_rate.country_name,
              ''
            ),

            NULLIF(
              u.country_code,
              ''
            ),

            'Unknown'
          )
            AS origin_country,

          origin_rate.country_code
            AS origin_country_code,

          cs.to_phone_e164
            AS destination_number,

          COALESCE(
            NULLIF(
              destination_rate.country_name,
              ''
            ),

            NULLIF(
              legacy_rate.country_name,
              ''
            ),

            NULLIF(
              cs.meta #>>
                '{pricing_snapshot,country_name}',
              ''
            ),

            'Unknown'
          )
            AS destination_country,

          COALESCE(
            destination_rate.country_code,
            legacy_rate.country_code,
            cs.meta #>>
              '{pricing_snapshot,country_code}'
          )
            AS destination_country_code,

          cs.started_at,

          cs.answered_at,

          cs.ended_at,

          GREATEST(
            COALESCE(
              cs.duration_sec,
              0
            ),
            0
          )::int
            AS duration_seconds,

          ROUND(
            GREATEST(
              COALESCE(
                cs.duration_sec,
                0
              ),
              0
            )::numeric / 60,
            2
          )
            AS duration_minutes,

          COALESCE(
            cs.charged_minutes,
            0
          )::int
            AS billed_minutes,

          COALESCE(
            cs.status,
            'unknown'
          )
            AS status,

          COALESCE(
            cs.provider_status,
            'unknown'
          )
            AS provider_status,

          COALESCE(
            cs.provider,
            'unknown'
          )
            AS provider,

            NULLIF(
  cs.meta ->>
    'provider_phone_number',
  ''
)
  AS provider_phone_number,

          cs.provider_call_id,

          COUNT(*) OVER()
            ::int
            AS filtered_total

        ${commonJoinSql}

        ${whereSql}

        ORDER BY
          cs.started_at DESC,
          cs.id DESC

        LIMIT ${limitPlaceholder}
        OFFSET ${offsetPlaceholder}
      `,
      queryValues
    );

  const rows =
    result.rows || [];

  return {
    total:
      rows.length > 0
        ? Number(
            rows[0]
              .filtered_total || 0
          )
        : 0,

    limit,
    offset,

    rows:
      rows.map((row) => {
        const {
          filtered_total,
          ...cleanRow
        } = row;

        return cleanRow;
      }),
  };
}

/**
 * ============================================================
 * 🇧🇩 CALL ACTIVITY SUMMARY
 *
 * Report-এর উপরের summary cards-এর জন্য।
 * ============================================================
 */
async function getCallActivitySummary(
  filters = {}
) {
  const {
    whereSql,
    values,
  } =
    buildFilters(filters);

  const result =
    await db.query(
      `
        SELECT
          COUNT(*)::int
            AS total_calls,

          COUNT(*) FILTER (
            WHERE
              cs.answered_at
                IS NOT NULL
          )::int
            AS answered_calls,

          COUNT(*) FILTER (
            WHERE
              cs.answered_at
                IS NULL
          )::int
            AS unanswered_calls,

          COUNT(*) FILTER (
            WHERE
              cs.status =
                'failed'
          )::int
            AS failed_calls,

          COALESCE(
            SUM(
              GREATEST(
                COALESCE(
                  cs.duration_sec,
                  0
                ),
                0
              )
            ),
            0
          )::bigint
            AS total_duration_seconds,

          COALESCE(
            SUM(
              COALESCE(
                cs.charged_minutes,
                0
              )
            ),
            0
          )::bigint
            AS total_billed_minutes,

          COUNT(
            DISTINCT
            cs.user_id
          )::int
            AS unique_users,

          COUNT(
            DISTINCT
            cs.to_phone_e164
          )::int
            AS unique_destination_numbers

        ${commonJoinSql}

        ${whereSql}
      `,
      values
    );

  return (
    result.rows[0] || {
      total_calls: 0,
      answered_calls: 0,
      unanswered_calls: 0,
      failed_calls: 0,
      total_duration_seconds: 0,
      total_billed_minutes: 0,
      unique_users: 0,
      unique_destination_numbers: 0,
    }
  );
}

/**
 * ============================================================
 * 🇧🇩 SINGLE CALL DETAILS
 *
 * Investigation-এর সময় একটি call-এর বিস্তারিত data।
 * ============================================================
 */
async function getCallActivityById(
  callId
) {
  const normalizedCallId =
    normalizePositiveInteger(
      callId,
      0,
      {
        min: 1,
      }
    );

  if (!normalizedCallId) {
    return null;
  }

  const result =
    await db.query(
      `
        SELECT
          cs.id
            AS call_id,

          cs.user_id,

          u.phone_e164
            AS registered_number,

          COALESCE(
            NULLIF(
              origin_rate.country_name,
              ''
            ),

            NULLIF(
              u.country_code,
              ''
            ),

            'Unknown'
          )
            AS origin_country,

          origin_rate.country_code
            AS origin_country_code,

          cs.to_phone_e164
            AS destination_number,

          COALESCE(
            NULLIF(
              destination_rate.country_name,
              ''
            ),

            NULLIF(
              legacy_rate.country_name,
              ''
            ),

            NULLIF(
              cs.meta #>>
                '{pricing_snapshot,country_name}',
              ''
            ),

            'Unknown'
          )
            AS destination_country,

          COALESCE(
            destination_rate.country_code,
            legacy_rate.country_code,
            cs.meta #>>
              '{pricing_snapshot,country_code}'
          )
            AS destination_country_code,

          cs.started_at,
          cs.answered_at,
          cs.ended_at,

          GREATEST(
            COALESCE(
              cs.duration_sec,
              0
            ),
            0
          )::int
            AS duration_seconds,

          ROUND(
            GREATEST(
              COALESCE(
                cs.duration_sec,
                0
              ),
              0
            )::numeric / 60,
            2
          )
            AS duration_minutes,

          COALESCE(
            cs.charged_minutes,
            0
          )::int
            AS billed_minutes,

          cs.status,
          cs.provider_status,
          cs.provider,

          NULLIF(
            cs.meta ->>
              'provider_phone_number',
            ''
          )
            AS provider_phone_number,

          cs.provider_call_id,

          cs.provider_call_leg_id,

          cs.provider_call_session_id,

          cs.billing_source,

          cs.charged_amount_usd,

          cs.provider_cost_usd,

          cs.profit_usd

        ${commonJoinSql}

        WHERE
          cs.id = $1::bigint

        LIMIT 1
      `,
      [normalizedCallId]
    );

  return (
    result.rows[0] ||
    null
  );
}

module.exports = {
  getCallActivityList,
  getCallActivitySummary,
  getCallActivityById,
};