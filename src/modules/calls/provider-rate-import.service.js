/**
 * provider-rate-import.service.js
 * --------------------------------------------------
 * NetPhone Multi-Provider Rate Deck Import Service
 *
 * এই file-এর কাজ:
 * 1. Provider CSV/rate deck stream করে পড়া
 * 2. CSV header validate করা
 * 3. Prefix, rate ও billing values normalize করা
 * 4. Duplicate prefix-এর ক্ষেত্রে Telnyx applicable destination rate রাখা
 * 5. voice_provider_rate_cards তৈরি করা
 * 6. voice_provider_rates table-এ batch import করা
 * 7. Successful import-এর পরে নতুন rate card activate করা
 * 8. Failed import cleanup করা
 *
 * File assembly order:
 * PART-1 -> PART-2 -> PART-3 -> PART-4
 */

/* =========================================================
 * PART-1 START
 * Core imports, constants, CSV parsing and normalization
 * ========================================================= */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");

const db = require("../../config/db");

/**
 * Telnyx CSV-এর প্রয়োজনীয় column/header।
 *
 * Import শুরু করার আগে প্রতিটি header আছে কি না পরীক্ষা হবে।
 * কোনো header না থাকলে import বন্ধ হবে।
 */
const REQUIRED_HEADERS = [
  "ISO",
  "Country",
  "Destination Prefixes",
  "Description",
  "Interval 1",
  "Interval N",
  "Rate",
  "Price Per Call",
  "Exact Match",
];

/**
 * একটি batch-এ সর্বোচ্চ কতটি normalized row database-এ যাবে।
 *
 * 500:
 * - PostgreSQL query খুব বড় হয় না
 * - memory usage কম থাকে
 * - বড় CSV stream করে import করা যায়
 */
const DEFAULT_BATCH_SIZE = 500;

/**
 * একটি CSV line parser।
 *
 * এটি support করে:
 * - Comma-separated fields
 * - Double-quoted fields
 * - Quoted field-এর ভিতরের comma
 * - Escaped double quote: ""
 *
 * Example:
 * AD,Andorra,376,"Andorra, Fixed",60,60,0.0373,0,false
 */
function parseCsvLine(line) {
  const values = [];

  let value = "";
  let quoted = false;

  for (
    let index = 0;
    index < line.length;
    index += 1
  ) {
    const character = line[index];

    /*
     * Quoted field শুরু/শেষ অথবা escaped quote detect করে।
     */
    if (character === '"') {
      if (
        quoted &&
        line[index + 1] === '"'
      ) {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }

      continue;
    }

    /*
     * Quote-এর বাইরে comma পাওয়া গেলে field শেষ।
     */
    if (
      character === "," &&
      !quoted
    ) {
      values.push(value);
      value = "";
      continue;
    }

    value += character;
  }

  /*
   * Line শেষ হলেও quote বন্ধ না হলে CSV malformed।
   */
  if (quoted) {
    throw new Error(
      "Malformed CSV row: unclosed quoted field"
    );
  }

  values.push(value);

  return values;
}

/**
 * Header normalize করে।
 *
 * CSV-এর প্রথম header-এ UTF-8 BOM থাকলে remove করে।
 */
function normalizeHeader(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim();
}

/**
 * Provider destination prefix normalize করে।
 *
 * Example:
 * +965 -> 965
 * 965-5 -> 9655
 *
 * শুধু 1–20 digit গ্রহণ করা হয়।
 */
function normalizePrefix(value) {
  const prefix = String(value || "")
    .replace(/\D/g, "");

  return /^[0-9]{1,20}$/.test(prefix)
    ? prefix
    : null;
}

/**
 * Positive decimal parser।
 *
 * Rate অবশ্যই zero-এর বেশি হতে হবে।
 */
function parsePositiveDecimal(value) {
  const number = Number(
    String(value || "").trim()
  );

  return (
    Number.isFinite(number) &&
    number > 0
  )
    ? number
    : null;
}

/**
 * Non-negative decimal parser।
 *
 * Connection fee-এর মতো field zero হতে পারে।
 */
function parseNonNegativeDecimal(
  value,
  fallback = 0
) {
  const text = String(value ?? "").trim();

  if (!text) {
    return fallback;
  }

  const number = Number(text);

  return (
    Number.isFinite(number) &&
    number >= 0
  )
    ? number
    : fallback;
}

/**
 * Positive integer parser।
 *
 * Billing increment অথবা minimum duration invalid হলে
 * fallback value ব্যবহার করবে।
 */
function parsePositiveInteger(
  value,
  fallback
) {
  const number = Number.parseInt(
    String(value || "").trim(),
    10
  );

  return (
    Number.isInteger(number) &&
    number > 0
  )
    ? number
    : fallback;
}

/**
 * CSV boolean text normalize করে।
 *
 * Supported true values:
 * true, t, yes, y, 1
 *
 * Supported false values:
 * false, f, no, n, 0
 */
function toBooleanOrNull(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (!normalized) {
    return null;
  }

  if (
    ["true", "t", "yes", "y", "1"]
      .includes(normalized)
  ) {
    return true;
  }

  if (
    ["false", "f", "no", "n", "0"]
      .includes(normalized)
  ) {
    return false;
  }

  return null;
}

/**
 * Provider rate-card-এর unique code তৈরি করে।
 *
 * Checksum ব্যবহার করার কারণে একই exact CSV আবার import করলে
 * duplicate rate card তৈরি হবে না।
 */
function makeRateCardCode(
  providerCode,
  planCode,
  checksum,
  uniqueSuffix = ""
) {
  const suffix = String(
    uniqueSuffix || ""
  )
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return (
    [
      providerCode,
      planCode,
      checksum.slice(0, 16),
      suffix,
    ]
      .filter(Boolean)
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100)
  );
}

/**
 * CSV file-এর SHA-256 checksum তৈরি করে।
 *
 * Import duplicate detection এবং audit trail-এর জন্য ব্যবহৃত হয়।
 */
async function sha256File(filePath) {
  return new Promise(
    (resolve, reject) => {
      const hash =
        crypto.createHash("sha256");

      const stream =
        fs.createReadStream(filePath);

      stream.on(
        "error",
        reject
      );

      stream.on(
        "data",
        (chunk) => hash.update(chunk)
      );

      stream.on(
        "end",
        () => resolve(
          hash.digest("hex")
        )
      );
    }
  );
}

/* =========================================================
 * PART-1 END
 *
 * PART-2 অবশ্যই এর ঠিক নিচে বসবে।
 * ========================================================= */
/**
 * Telnyx duplicate destination description normalize করে।
 */
function normalizeDestinationDescription(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Telnyx rate deck-এ একই prefix-এর duplicate row থাকলে
 * কোন row public outbound termination-এর জন্য বেশি applicable
 * সেটি নির্ধারণ করে।
 *
 * CDR verification অনুযায়ী:
 *
 * Bangladesh       88017  0.0201  -> applicable
 * Bangladesh local 88017  0.0975  -> alternate/local variant
 *
 * Lower score = higher priority.
 */
function getTelnyxDuplicatePreference(row) {
  const description =
    normalizeDestinationDescription(
      row?.destination_name
    );

  /*
   * “local” destination variant সাধারণ public outbound
   * termination row-এর পরে থাকবে।
   */
  const isLocalVariant =
    /\blocal\b/i.test(description);

  /*
   * কিছু rate deck-এ special/premium destination থাকতে পারে।
   * এগুলো সাধারণ outbound destination-এর ওপর priority পাবে না।
   */
  const isSpecialVariant =
    /\b(premium|special|satellite|shared cost|toll free)\b/i
      .test(description);

  let categoryPriority = 0;

  if (isLocalVariant) {
    categoryPriority += 100;
  }

  if (isSpecialVariant) {
    categoryPriority += 200;
  }

  return {
    category_priority:
      categoryPriority,

    is_local_variant:
      isLocalVariant,

    is_special_variant:
      isSpecialVariant,

    normalized_description:
      description,
  };
}

/**
 * একই prefix-এর দুটি Telnyx row-এর মধ্যে applicable row নির্বাচন করে।
 *
 * Priority:
 * 1. সাধারণ outbound row
 * 2. lower provider rate
 * 3. lower connection fee
 * 4. earlier CSV source row
 */
function selectPreferredDuplicateRateRow(
  existingRow,
  currentRow
) {
  const existingPreference =
    getTelnyxDuplicatePreference(
      existingRow
    );

  const currentPreference =
    getTelnyxDuplicatePreference(
      currentRow
    );

  if (
    currentPreference.category_priority <
    existingPreference.category_priority
  ) {
    return currentRow;
  }

  if (
    currentPreference.category_priority >
    existingPreference.category_priority
  ) {
    return existingRow;
  }

  const existingRate = Number(
    existingRow?.raw_rate_usd_per_min || 0
  );

  const currentRate = Number(
    currentRow?.raw_rate_usd_per_min || 0
  );

  if (currentRate < existingRate) {
    return currentRow;
  }

  if (currentRate > existingRate) {
    return existingRow;
  }

  const existingConnectionFee = Number(
    existingRow?.connection_fee_usd || 0
  );

  const currentConnectionFee = Number(
    currentRow?.connection_fee_usd || 0
  );

  if (
    currentConnectionFee <
    existingConnectionFee
  ) {
    return currentRow;
  }

  if (
    currentConnectionFee >
    existingConnectionFee
  ) {
    return existingRow;
  }

  const existingSourceLine = Number(
    existingRow?.metadata?.source_line ||
    Number.MAX_SAFE_INTEGER
  );

  const currentSourceLine = Number(
    currentRow?.metadata?.source_line ||
    Number.MAX_SAFE_INTEGER
  );

  return currentSourceLine <
    existingSourceLine
      ? currentRow
      : existingRow;
}
/* =========================================================
 * PART-2 START
 * CSV row normalization and PostgreSQL batch insertion
 * ========================================================= */

/**
 * একটি raw CSV row-কে provider-rate object-এ convert করে।
 *
 * Invalid prefix বা invalid rate হলে row skip হবে।
 */
function buildRow(
  headerIndex,
  values,
  sourceLine
) {
  /**
   * Header name অনুযায়ী current row-এর value ফেরত দেয়।
   */
  const get = (header) => {
    const index = headerIndex.get(header);

    return values[index] ?? "";
  };

  const prefix = normalizePrefix(
    get("Destination Prefixes")
  );

  const rawRate = parsePositiveDecimal(
    get("Rate")
  );

  /*
   * Destination prefix ছাড়া routing সম্ভব নয়।
   */
  if (!prefix) {
    return {
      skip: true,
      reason:
        "invalid_or_missing_prefix",
    };
  }

  /*
   * Zero/negative/invalid provider rate import করা যাবে না।
   */
  if (rawRate === null) {
    return {
      skip: true,
      reason:
        "invalid_or_missing_rate",
    };
  }

  const countryCode = (
    String(get("ISO") || "")
      .trim()
      .toUpperCase()
      .slice(0, 8) ||
    null
  );

  const countryName = (
    String(get("Country") || "")
      .trim()
      .slice(0, 120) ||
    null
  );

  const destinationName = (
    String(get("Description") || "")
      .trim()
      .slice(0, 180) ||
    null
  );

  /**
   * Telnyx CSV:
   * Interval N সাধারণত billing increment।
   * Interval 1 সাধারণত minimum duration।
   */
  const billingIncrementSeconds =
    parsePositiveInteger(
      get("Interval N"),
      60
    );

  const minimumDurationSeconds =
    parsePositiveInteger(
      get("Interval 1"),
      60
    );

  const connectionFeeUsd =
    parseNonNegativeDecimal(
      get("Price Per Call"),
      0
    );

  return {
    skip: false,

    row: {
      country_code:
        countryCode,

      country_name:
        countryName,

      destination_name:
        destinationName,

      prefix,

      raw_rate_usd_per_min:
        rawRate,

      connection_fee_usd:
        connectionFeeUsd,

      billing_increment_seconds:
        billingIncrementSeconds,

      minimum_duration_seconds:
        minimumDurationSeconds,

     metadata: {
    source_line:
    sourceLine,

  exact_match:
    toBooleanOrNull(
      get("Exact Match")
    ),

  /*
   * Duplicate selection এখন Telnyx CDR-verified
   * destination preference ব্যবহার করবে।
   */
  duplicate_strategy:
    "telnyx_applicable_destination_then_lowest_rate",

  duplicate_preference:
    getTelnyxDuplicatePreference({
      destination_name:
        destinationName,
    }),
    },
    },
  };
}


/**
 * একই database batch-এর duplicate prefix merge করে।
 *
 * Telnyx CDR-verified duplicate policy:
 *
 * 1. সাধারণ outbound destination row আগে
 * 2. “local”/special variant পরে
 * 3. একই category হলে lower provider rate
 * 4. একই rate হলে lower connection fee
 *
 * এটি PostgreSQL error 21000-ও প্রতিরোধ করে।
 */
function mergeDuplicatePrefixesInBatch(rows) {
  const rowsByPrefix = new Map();

  for (const currentRow of rows) {
    const existingRow =
      rowsByPrefix.get(
        currentRow.prefix
      );

    if (!existingRow) {
      rowsByPrefix.set(
        currentRow.prefix,
        {
          ...currentRow,

          metadata: {
            ...(currentRow.metadata || {}),

            duplicate_rows_merged_in_batch:
              0,
          },
        }
      );

      continue;
    }

    const preferredRow =
      selectPreferredDuplicateRateRow(
        existingRow,
        currentRow
      );

    const rejectedRow =
      preferredRow === currentRow
        ? existingRow
        : currentRow;

    const existingMergedCount = Number(
      existingRow.metadata
        ?.duplicate_rows_merged_in_batch ||
      0
    );

    rowsByPrefix.set(
      currentRow.prefix,
      {
        ...preferredRow,

        /*
         * Connection fee preferred applicable row থেকেই নেওয়া হবে।
         * Highest fee নেওয়া হবে না—কারণ সেটিও alternate destination
         * variant-এর fee হতে পারে।
         */
        connection_fee_usd:
          Number(
            preferredRow
              .connection_fee_usd ||
            0
          ),

        metadata: {
          ...(existingRow.metadata || {}),
          ...(currentRow.metadata || {}),
          ...(preferredRow.metadata || {}),

          duplicate_prefix_detected:
            true,

          duplicate_rows_merged_in_batch:
            existingMergedCount + 1,

          duplicate_strategy:
            "telnyx_applicable_destination_then_lowest_rate",

          selected_destination_name:
            preferredRow.destination_name ||
            null,

          selected_rate_usd_per_min:
            Number(
              preferredRow
                .raw_rate_usd_per_min ||
              0
            ),

          rejected_duplicate: {
            destination_name:
              rejectedRow
                .destination_name ||
              null,

            raw_rate_usd_per_min:
              Number(
                rejectedRow
                  .raw_rate_usd_per_min ||
                0
              ),

            source_line:
              rejectedRow.metadata
                ?.source_line ||
              null,
          },

          duplicate_preference:
            getTelnyxDuplicatePreference(
              preferredRow
            ),
        },
      }
    );
  }

  return Array.from(
    rowsByPrefix.values()
  );
}



/**
 * Normalized rate rows PostgreSQL-এ batch আকারে insert করে।
 *
 * Duplicate policy:
 * - general outbound destination preferred
 * - local/special variant lower priority
 * - same category হলে lower rate
 * - same rate হলে lower connection fee
 */
async function insertBatch(
  client,
  {
    rateCardId,
    providerId,
    rows,
  }
) {
  if (!rows.length) {
    return {
      input_rows: 0,
      unique_rows: 0,
      duplicate_rows_merged: 0,
    };
  }

  const uniqueRows =
    mergeDuplicatePrefixesInBatch(rows);

  const duplicateRowsMerged =
    rows.length -
    uniqueRows.length;

  await client.query(
    `
    WITH incoming AS (
      SELECT *
      FROM jsonb_to_recordset(
        $3::jsonb
      ) AS x(
        country_code TEXT,
        country_name TEXT,
        destination_name TEXT,
        prefix TEXT,
        raw_rate_usd_per_min NUMERIC,
        connection_fee_usd NUMERIC,
        billing_increment_seconds INTEGER,
        minimum_duration_seconds INTEGER,
        metadata JSONB
      )
    )

    INSERT INTO voice_provider_rates (
      rate_card_id,
      provider_id,

      country_code,
      country_name,
      destination_name,
      prefix,

      raw_rate_usd_per_min,
      connection_fee_usd,

      billing_increment_seconds,
      minimum_duration_seconds,

      is_active,
      metadata
    )

    SELECT
      $1,
      $2,

      NULLIF(country_code, ''),
      NULLIF(country_name, ''),
      NULLIF(destination_name, ''),
      prefix,

      raw_rate_usd_per_min,
      connection_fee_usd,

      billing_increment_seconds,
      minimum_duration_seconds,

      TRUE,

      COALESCE(
        metadata,
        '{}'::jsonb
      )

    FROM incoming

    ON CONFLICT (
      rate_card_id,
      prefix
    )

    DO UPDATE SET
      country_code =
        CASE
          WHEN
            (
              COALESCE(
                (
                  EXCLUDED.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              <
              COALESCE(
                (
                  voice_provider_rates.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
            )
            OR
            (
              COALESCE(
                (
                  EXCLUDED.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              =
              COALESCE(
                (
                  voice_provider_rates.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              AND
              EXCLUDED.raw_rate_usd_per_min
              <
              voice_provider_rates
                .raw_rate_usd_per_min
            )
          THEN
            COALESCE(
              EXCLUDED.country_code,
              voice_provider_rates.country_code
            )
          ELSE
            voice_provider_rates.country_code
        END,

      country_name =
        CASE
          WHEN
            (
              COALESCE(
                (
                  EXCLUDED.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              <
              COALESCE(
                (
                  voice_provider_rates.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
            )
            OR
            (
              COALESCE(
                (
                  EXCLUDED.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              =
              COALESCE(
                (
                  voice_provider_rates.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              AND
              EXCLUDED.raw_rate_usd_per_min
              <
              voice_provider_rates
                .raw_rate_usd_per_min
            )
          THEN
            COALESCE(
              EXCLUDED.country_name,
              voice_provider_rates.country_name
            )
          ELSE
            voice_provider_rates.country_name
        END,

      destination_name =
        CASE
          WHEN
            (
              COALESCE(
                (
                  EXCLUDED.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              <
              COALESCE(
                (
                  voice_provider_rates.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
            )
            OR
            (
              COALESCE(
                (
                  EXCLUDED.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              =
              COALESCE(
                (
                  voice_provider_rates.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              AND
              (
                EXCLUDED.raw_rate_usd_per_min
                <
                voice_provider_rates
                  .raw_rate_usd_per_min

                OR
                (
                  EXCLUDED.raw_rate_usd_per_min
                  =
                  voice_provider_rates
                    .raw_rate_usd_per_min

                  AND

                  EXCLUDED.connection_fee_usd
                  <
                  voice_provider_rates
                    .connection_fee_usd
                )
              )
            )
          THEN
            EXCLUDED.destination_name
          ELSE
            voice_provider_rates.destination_name
        END,

      raw_rate_usd_per_min =
        CASE
          WHEN
            (
              COALESCE(
                (
                  EXCLUDED.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              <
              COALESCE(
                (
                  voice_provider_rates.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
            )
            OR
            (
              COALESCE(
                (
                  EXCLUDED.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              =
              COALESCE(
                (
                  voice_provider_rates.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              AND
              (
                EXCLUDED.raw_rate_usd_per_min
                <
                voice_provider_rates
                  .raw_rate_usd_per_min

                OR
                (
                  EXCLUDED.raw_rate_usd_per_min
                  =
                  voice_provider_rates
                    .raw_rate_usd_per_min

                  AND

                  EXCLUDED.connection_fee_usd
                  <
                  voice_provider_rates
                    .connection_fee_usd
                )
              )
            )
          THEN
            EXCLUDED.raw_rate_usd_per_min
          ELSE
            voice_provider_rates
              .raw_rate_usd_per_min
        END,

      connection_fee_usd =
        CASE
          WHEN
            (
              COALESCE(
                (
                  EXCLUDED.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              <
              COALESCE(
                (
                  voice_provider_rates.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
            )
            OR
            (
              COALESCE(
                (
                  EXCLUDED.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              =
              COALESCE(
                (
                  voice_provider_rates.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              AND
              (
                EXCLUDED.raw_rate_usd_per_min
                <
                voice_provider_rates
                  .raw_rate_usd_per_min

                OR
                (
                  EXCLUDED.raw_rate_usd_per_min
                  =
                  voice_provider_rates
                    .raw_rate_usd_per_min

                  AND

                  EXCLUDED.connection_fee_usd
                  <
                  voice_provider_rates
                    .connection_fee_usd
                )
              )
            )
          THEN
            EXCLUDED.connection_fee_usd
          ELSE
            voice_provider_rates
              .connection_fee_usd
        END,

      billing_increment_seconds =
        CASE
          WHEN
            (
              COALESCE(
                (
                  EXCLUDED.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              <
              COALESCE(
                (
                  voice_provider_rates.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
            )
            OR
            (
              COALESCE(
                (
                  EXCLUDED.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              =
              COALESCE(
                (
                  voice_provider_rates.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              AND
              EXCLUDED.raw_rate_usd_per_min
              <=
              voice_provider_rates
                .raw_rate_usd_per_min
            )
          THEN
            EXCLUDED.billing_increment_seconds
          ELSE
            voice_provider_rates
              .billing_increment_seconds
        END,

      minimum_duration_seconds =
        CASE
          WHEN
            (
              COALESCE(
                (
                  EXCLUDED.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              <
              COALESCE(
                (
                  voice_provider_rates.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
            )
            OR
            (
              COALESCE(
                (
                  EXCLUDED.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              =
              COALESCE(
                (
                  voice_provider_rates.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              AND
              EXCLUDED.raw_rate_usd_per_min
              <=
              voice_provider_rates
                .raw_rate_usd_per_min
            )
          THEN
            EXCLUDED.minimum_duration_seconds
          ELSE
            voice_provider_rates
              .minimum_duration_seconds
        END,

      is_active =
        TRUE,

      metadata =
        CASE
          WHEN
            (
              COALESCE(
                (
                  EXCLUDED.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              <
              COALESCE(
                (
                  voice_provider_rates.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
            )
            OR
            (
              COALESCE(
                (
                  EXCLUDED.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              =
              COALESCE(
                (
                  voice_provider_rates.metadata
                    #>>
                  '{duplicate_preference,category_priority}'
                )::integer,
                0
              )
              AND
              (
                EXCLUDED.raw_rate_usd_per_min
                <
                voice_provider_rates
                  .raw_rate_usd_per_min

                OR
                (
                  EXCLUDED.raw_rate_usd_per_min
                  =
                  voice_provider_rates
                    .raw_rate_usd_per_min

                  AND

                  EXCLUDED.connection_fee_usd
                  <
                  voice_provider_rates
                    .connection_fee_usd
                )
              )
            )
          THEN
            voice_provider_rates.metadata
            ||
            EXCLUDED.metadata
            ||
            jsonb_build_object(
              'duplicate_prefix_detected',
              TRUE,

              'duplicate_strategy',
              'telnyx_applicable_destination_then_lowest_rate'
            )
          ELSE
            voice_provider_rates.metadata
            ||
            jsonb_build_object(
              'duplicate_prefix_detected',
              TRUE,

              'duplicate_strategy',
              'telnyx_applicable_destination_then_lowest_rate',

              'rejected_later_duplicate',
              jsonb_build_object(
                'destination_name',
                EXCLUDED.destination_name,

                'raw_rate_usd_per_min',
                EXCLUDED.raw_rate_usd_per_min,

                'source_line',
                EXCLUDED.metadata->'source_line'
              )
            )
        END,

      updated_at =
        NOW()
    `,
    [
      rateCardId,
      providerId,
      JSON.stringify(uniqueRows),
    ]
  );

  return {
    input_rows:
      rows.length,

    unique_rows:
      uniqueRows.length,

    duplicate_rows_merged:
      duplicateRowsMerged,
  };
}

/* =========================================================
 * PART-2 END
 *
 * PART-3 অবশ্যই এর ঠিক নিচে বসবে।
 * এখন file save করবেন, কিন্তু syntax check করবেন না।
 * কারণ PART-3 ও PART-4 ছাড়া file এখনো অসম্পূর্ণ।
 * ========================================================= */

/* =========================================================
 * PART-3 START
 * Provider/plan validation, staging rate-card creation
 * and main transaction-safe CSV import flow
 * ========================================================= */

/**
 * Provider এবং provider plan database থেকে resolve করে।
 *
 * Required:
 * - provider active হতে হবে
 * - provider voice support করতে হবে
 * - plan active হতে হবে
 */
async function resolveProviderAndPlan(
  client,
  {
    providerCode,
    planCode,
  }
) {
  const providerResult = await client.query(
    `
    SELECT
      id,
      code,
      name,
      status,
      supports_voice,
      default_currency
    FROM voice_providers
    WHERE code = $1
    LIMIT 1
    `,
    [providerCode]
  );

  const provider = providerResult.rows[0];

  if (!provider) {
    throw new Error(
      `Voice provider not found: ${providerCode}`
    );
  }

  if (provider.status !== "active") {
    throw new Error(
      `Voice provider is not active: ${providerCode}`
    );
  }

  if (provider.supports_voice !== true) {
    throw new Error(
      `Voice provider does not support voice: ${providerCode}`
    );
  }

  const planResult = await client.query(
    `
    SELECT
      id,
      provider_id,
      code,
      name,
      plan_tier,
      discount_percent,
      platform_fee_usd_per_min,
      is_active,
      is_default
    FROM voice_provider_plans
    WHERE provider_id = $1
      AND code = $2
    LIMIT 1
    `,
    [
      provider.id,
      planCode,
    ]
  );

  const plan = planResult.rows[0];

  if (!plan) {
    throw new Error(
      `Provider plan not found: ${providerCode}/${planCode}`
    );
  }

  if (plan.is_active !== true) {
    throw new Error(
      `Provider plan is not active: ${providerCode}/${planCode}`
    );
  }

  return {
    provider,
    plan,
  };
}

/**
 * Exact same checksum-এর rate card আগে import হয়েছে কি না দেখবে।
 */
async function findExistingRateCardByChecksum(
  client,
  {
    providerId,
    checksum,
  }
) {
  const { rows } = await client.query(
    `
    SELECT
      id,
      code,
      name,
      is_active,
      metadata,
      created_at
    FROM voice_provider_rate_cards
    WHERE provider_id = $1
      AND metadata->>'source_sha256' = $2
    ORDER BY id DESC
    LIMIT 1
    `,
    [
      providerId,
      checksum,
    ]
  );

  return rows[0] || null;
}

/**
 * Import শুরুর আগে inactive staging rate card তৈরি করে।
 *
 * Import সফল না হওয়া পর্যন্ত এটি active হবে না।
 */
async function createStagingRateCard(
  client,
  {
    provider,
    plan,
    checksum,
    sourceFileName,
    rateCardCode,
  }
) {
  const result = await client.query(
    `
    INSERT INTO voice_provider_rate_cards (
      provider_id,
      provider_plan_id,

      code,
      name,
      currency,

      billing_increment_seconds,
      minimum_duration_seconds,

      is_active,
      effective_from,
      effective_until,

      metadata
    )
    VALUES (
      $1,
      $2,

      $3,
      $4,
      $5,

      60,
      60,

      FALSE,
      NULL,
      NULL,

      jsonb_build_object(
        'import_status',
        'staging',

        'source_file_name',
        $6::text,

        'source_sha256',
        $7::text,

        'provider_code',
        $8::text,

        'provider_plan_code',
        $9::text,

        'duplicate_strategy',
        'telnyx_applicable_destination_then_lowest_rate',

        'created_by',
        'provider-rate-import.service'
      )
    )
    RETURNING *
    `,
    [
      provider.id,
      plan.id,

      rateCardCode,
      `${provider.name} ${plan.name} Imported Rate Card`,
      provider.default_currency || "USD",

      sourceFileName,
      checksum,
      provider.code,
      plan.code,
    ]
  );

  return result.rows[0];
}

/**
 * Required CSV headers validate করে এবং name->index map বানায়।
 */
function buildHeaderIndex(headerValues) {
  const normalizedHeaders =
    headerValues.map(normalizeHeader);

  const headerIndex = new Map();

  normalizedHeaders.forEach(
    (header, index) => {
      if (header) {
        headerIndex.set(header, index);
      }
    }
  );

  const missingHeaders =
    REQUIRED_HEADERS.filter(
      (header) =>
        !headerIndex.has(header)
    );

  if (missingHeaders.length > 0) {
    throw new Error(
      `CSV required header missing: ${missingHeaders.join(", ")}`
    );
  }

  return headerIndex;
}

/**
 * CSV file stream করে database-এ import করে।
 *
 * Important safety behavior:
 * - Full file memory-তে load হয় না
 * - Batch insert হয়
 * - Same checksum duplicate import block হয়
 * - New rate card staging অবস্থায় থাকে
 * - Import successful হলে activate হয়
 * - Failure হলে transaction rollback হয়
 */
async function importProviderRateDeck({
  filePath,
  providerCode = "telnyx",
  planCode = "payg",
  batchSize = DEFAULT_BATCH_SIZE,
  allowDuplicateChecksum = false,
} = {}) {
  if (
    typeof filePath !== "string" ||
    !filePath.trim()
  ) {
    throw new Error(
      "Rate deck filePath is required"
    );
  }

  const absoluteFilePath =
    path.resolve(filePath);

  const fileStat = await fs.promises.stat(
    absoluteFilePath
  );

  if (!fileStat.isFile()) {
    throw new Error(
      `Rate deck path is not a file: ${absoluteFilePath}`
    );
  }

  const safeBatchSize =
    Number.isInteger(Number(batchSize)) &&
    Number(batchSize) > 0 &&
    Number(batchSize) <= 5000
      ? Number(batchSize)
      : DEFAULT_BATCH_SIZE;

  const checksum =
    await sha256File(absoluteFilePath);

  const sourceFileName =
    path.basename(absoluteFilePath);

  const normalizedProviderCode =
    String(providerCode)
      .trim()
      .toLowerCase();

  const normalizedPlanCode =
    String(planCode)
      .trim()
      .toLowerCase();

  if (!normalizedProviderCode) {
    throw new Error(
      "providerCode is required"
    );
  }

  if (!normalizedPlanCode) {
    throw new Error(
      "planCode is required"
    );
  }

  const client = await db.pool.connect();

  let rateCard = null;

  const summary = {
    ok: false,

    provider_code:
      normalizedProviderCode,

    provider_plan_code:
      normalizedPlanCode,

    source_file:
      sourceFileName,

    source_path:
      absoluteFilePath,

    source_sha256:
      checksum,

    source_size_bytes:
      Number(fileStat.size || 0),

    batch_size:
      safeBatchSize,

    total_lines_read: 0,
    data_rows_read: 0,

    rows_imported_or_merged: 0,

    rows_skipped: 0,

    skipped_by_reason: {
      invalid_or_missing_prefix: 0,
      invalid_or_missing_rate: 0,
      malformed_csv_row: 0,
      column_count_mismatch: 0,
    },

    rate_card_id: null,
    rate_card_code: null,

    duplicate_import:
      false,

    started_at:
      new Date().toISOString(),

    completed_at:
      null,
  };

  try {
    await client.query("BEGIN");

    /*
     * একই provider-এর concurrent rate import আটকাতে
     * transaction-scoped advisory lock নেওয়া হয়।
     */
    await client.query(
      `
      SELECT pg_advisory_xact_lock(
        hashtext($1)
      )
      `,
      [
        `voice-rate-import:${normalizedProviderCode}`,
      ]
    );

    const {
      provider,
      plan,
    } = await resolveProviderAndPlan(
      client,
      {
        providerCode:
          normalizedProviderCode,

        planCode:
          normalizedPlanCode,
      }
    );

    const existingRateCard =
      await findExistingRateCardByChecksum(
        client,
        {
          providerId:
            provider.id,

          checksum,
        }
      );

    /*
    * একই exact CSV আগে import হয়ে থাকলে database পরিবর্তন করা হবে না।
    * গুরুত্বপূর্ণ:
    * Transaction commit করার পর PostgreSQL connection release করা হচ্ছে,
    * যাতে duplicate import check-এর সময় connection leak না হয়।
    */
    if (
        existingRateCard &&
        !allowDuplicateChecksum
    ) {
        summary.ok = true;
        summary.duplicate_import = true;
        summary.rate_card_id =
            existingRateCard.id;
        summary.rate_card_code =
            existingRateCard.code;
        summary.completed_at =
            new Date().toISOString();

        await client.query("COMMIT");
        client.release();

        return summary;
    }

    const rateCardCode =
    makeRateCardCode(
    provider.code,
    plan.code,
    checksum,

    allowDuplicateChecksum
      ? Date.now().toString(36)
      : ""
    );

    rateCard =
      await createStagingRateCard(
        client,
        {
          provider,
          plan,
          checksum,
          sourceFileName,
          rateCardCode,
        }
      );

    summary.rate_card_id =
      rateCard.id;

    summary.rate_card_code =
      rateCard.code;

    const inputStream =
      fs.createReadStream(
        absoluteFilePath,
        {
          encoding: "utf8",
        }
      );

    const lineReader =
      readline.createInterface({
        input: inputStream,
        crlfDelay: Infinity,
      });

    let headerIndex = null;
    let expectedColumnCount = null;
    let currentBatch = [];

    for await (
      const rawLine of lineReader
    ) {
      summary.total_lines_read += 1;

      /*
       * Completely empty line ignore করা হয়।
       */
      if (
        !rawLine ||
        !rawLine.trim()
      ) {
        continue;
      }

      let values;

      try {
        values = parseCsvLine(rawLine);
      } catch {
        summary.rows_skipped += 1;
        summary.skipped_by_reason
          .malformed_csv_row += 1;
        continue;
      }

      /*
       * প্রথম non-empty line হলো CSV header।
       */
      if (!headerIndex) {
        headerIndex =
          buildHeaderIndex(values);

        expectedColumnCount =
          values.length;

        continue;
      }

      summary.data_rows_read += 1;

      /*
       * Broken row-এর column count header-এর সঙ্গে না মিললে skip।
       */
      if (
        values.length !==
        expectedColumnCount
      ) {
        summary.rows_skipped += 1;
        summary.skipped_by_reason
          .column_count_mismatch += 1;
        continue;
      }

      const built = buildRow(
        headerIndex,
        values,
        summary.total_lines_read
      );

      if (built.skip) {
        summary.rows_skipped += 1;

        if (
          Object.prototype.hasOwnProperty.call(
            summary.skipped_by_reason,
            built.reason
          )
        ) {
          summary.skipped_by_reason[
            built.reason
          ] += 1;
        }

        continue;
      }

      currentBatch.push(
        built.row
      );

      if (
        currentBatch.length >=
        safeBatchSize
      ) {
        await insertBatch(
          client,
          {
            rateCardId:
              rateCard.id,

            providerId:
              provider.id,

            rows:
              currentBatch,
          }
        );

        summary.rows_imported_or_merged +=
          currentBatch.length;

        currentBatch = [];
      }
    }

    /*
     * CSV header পাওয়া না গেলে file invalid।
     */
    if (!headerIndex) {
      throw new Error(
        "CSV header row was not found"
      );
    }

    /*
     * শেষ অসম্পূর্ণ batch insert।
     */
    if (currentBatch.length > 0) {
      await insertBatch(
        client,
        {
          rateCardId:
            rateCard.id,

          providerId:
            provider.id,

          rows:
            currentBatch,
        }
      );

      summary.rows_imported_or_merged +=
        currentBatch.length;
    }

    /*
     * Import শেষে অন্তত একটি active rate থাকা আবশ্যক।
     */
    const importedRateCountResult =
      await client.query(
        `
        SELECT COUNT(*)::bigint AS total
        FROM voice_provider_rates
        WHERE rate_card_id = $1
          AND is_active = TRUE
        `,
        [rateCard.id]
      );

    const importedUniqueRateCount =
      Number(
        importedRateCountResult
          .rows[0]?.total || 0
      );

    if (importedUniqueRateCount <= 0) {
      throw new Error(
        "Rate deck import produced zero valid provider rates"
      );
    }

    summary.unique_rates_imported =
      importedUniqueRateCount;

    /*
     * Part-4-এ:
     * - previous card deactivate
     * - current card activate
     * - metadata finalize
     * - transaction commit
     * সম্পন্ন হবে।
     */

    return {
      client,
      provider,
      plan,
      rateCard,
      summary,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Original import error preserve করা হচ্ছে।
    }

    client.release();

    throw error;
  }
}

/* =========================================================
 * PART-3 END
 *
 * PART-4 অবশ্যই এর ঠিক নিচে বসবে।
 * এখনো syntax check করবেন না।
 * PART-4 finalization এবং module.exports যোগ করবে।
 * ========================================================= */

/* =========================================================
 * PART-4 START
 * Rate-card activation, final transaction commit,
 * dry-run validation, maintenance cleanup and exports
 * ========================================================= */

/**
 * Successful staging import final করে।
 *
 * কাজ:
 * 1. একই provider-এর আগের active rate card deactivate
 * 2. নতুন rate card activate
 * 3. Import summary metadata save
 * 4. Existing active route-provider assignment নতুন card-এ update
 * 5. Transaction commit
 */
async function finalizeProviderRateDeckImport(
  stagedImport
) {
  const {
    client,
    provider,
    plan,
    rateCard,
    summary,
  } = stagedImport;

  try {
    /*
     * একই provider/plan-এর আগের active rate card deactivate।
     *
     * Historical call session data delete হবে না।
     */
    const deactivatedResult =
      await client.query(
        `
        UPDATE voice_provider_rate_cards
        SET
          is_active = FALSE,
          effective_until =
            COALESCE(
              effective_until,
              NOW()
            ),

          metadata =
            COALESCE(
              metadata,
              '{}'::jsonb
            )
            ||
            jsonb_build_object(
              'deactivated_reason',
              'superseded_by_new_import',

              'superseded_by_rate_card_id',
              $3::bigint,

              'deactivated_at',
              NOW()
            ),

          updated_at = NOW()

        WHERE provider_id = $1
          AND provider_plan_id = $2
          AND id <> $3
          AND is_active = TRUE
        `,
        [
          provider.id,
          plan.id,
          rateCard.id,
        ]
      );

    summary.previous_rate_cards_deactivated =
      deactivatedResult.rowCount;

    /*
     * নতুন imported rate card active করা হয়।
     */
    const activatedResult =
      await client.query(
        `
        UPDATE voice_provider_rate_cards
        SET
          is_active = TRUE,

          effective_from =
            COALESCE(
              effective_from,
              NOW()
            ),

          effective_until = NULL,

          metadata =
            COALESCE(
              metadata,
              '{}'::jsonb
            )
            ||
            jsonb_build_object(
              'import_status',
              'completed',

              'import_completed_at',
              NOW(),

              'total_lines_read',
              $2::bigint,

              'data_rows_read',
              $3::bigint,

              'rows_imported_or_merged',
              $4::bigint,

              'unique_rates_imported',
              $5::bigint,

              'rows_skipped',
              $6::bigint,

              'skipped_by_reason',
              $7::jsonb
            ),

          updated_at = NOW()

        WHERE id = $1

        RETURNING
          id,
          code,
          name,
          is_active,
          effective_from,
          effective_until,
          metadata
        `,
        [
          rateCard.id,

          summary.total_lines_read,
          summary.data_rows_read,
          summary.rows_imported_or_merged,
          summary.unique_rates_imported,
          summary.rows_skipped,

          JSON.stringify(
            summary.skipped_by_reason
          ),
        ]
      );

    if (!activatedResult.rows.length) {
      throw new Error(
        "Imported rate card could not be activated"
      );
    }

    /*
     * আগে থেকে active route-provider configuration থাকলে
     * একই provider এবং plan-এর জন্য নতুন active card assign হবে।
     *
     * নতুন route তৈরি বা inactive route activate করা হবে না।
     */
    const routeProviderUpdateResult =
      await client.query(
        `
        UPDATE voice_route_providers
        SET
          rate_card_id = $3,
          updated_at = NOW(),

          metadata =
            COALESCE(
              metadata,
              '{}'::jsonb
            )
            ||
            jsonb_build_object(
              'rate_card_updated_by',
              'provider-rate-import.service',

              'rate_card_updated_at',
              NOW()
            )

        WHERE provider_id = $1
          AND provider_plan_id = $2
          AND is_active = TRUE
        `,
        [
          provider.id,
          plan.id,
          rateCard.id,
        ]
      );

    summary.route_providers_updated =
      routeProviderUpdateResult.rowCount;

    summary.ok = true;
    summary.completed_at =
      new Date().toISOString();

    summary.rate_card = {
      id:
        activatedResult.rows[0].id,

      code:
        activatedResult.rows[0].code,

      name:
        activatedResult.rows[0].name,

      is_active:
        activatedResult.rows[0].is_active,

      effective_from:
        activatedResult.rows[0]
          .effective_from,

      effective_until:
        activatedResult.rows[0]
          .effective_until,
    };

    await client.query("COMMIT");

    return summary;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Original error preserve করা হচ্ছে।
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Public production import function।
 *
 * Part-3-এর staging import এবং Part-4-এর activation
 * একসঙ্গে safely চালায়।
 */
async function importAndActivateProviderRateDeck(
  options = {}
) {
  const stagedImport =
    await importProviderRateDeck(options);

  /*
   * একই exact checksum আগে import হয়ে থাকলে Part-3 সরাসরি
   * completed duplicate summary return করে।
   */
  if (
    stagedImport?.ok === true &&
    stagedImport?.duplicate_import === true
  ) {
    return stagedImport;
  }

  if (
    !stagedImport?.client ||
    !stagedImport?.rateCard
  ) {
    throw new Error(
      "Invalid staged rate-deck import result"
    );
  }

  return finalizeProviderRateDeckImport(
    stagedImport
  );
}

/**
 * CSV database-এ insert না করে validation/dry-run চালায়।
 *
 * এটি পরীক্ষা করে:
 * - file exists
 * - SHA-256
 * - required headers
 * - row structure
 * - valid prefix/rate
 * - skipped row reasons
 * - duplicate prefix count
 *
 * কোনো database table পরিবর্তন করবে না।
 */
async function validateProviderRateDeckFile({
  filePath,
  sampleLimit = 10,
} = {}) {
  if (
    typeof filePath !== "string" ||
    !filePath.trim()
  ) {
    throw new Error(
      "Rate deck filePath is required"
    );
  }

  const absoluteFilePath =
    path.resolve(filePath);

  const fileStat =
    await fs.promises.stat(
      absoluteFilePath
    );

  if (!fileStat.isFile()) {
    throw new Error(
      `Rate deck path is not a file: ${absoluteFilePath}`
    );
  }

  const checksum =
    await sha256File(
      absoluteFilePath
    );

  const safeSampleLimit =
    Number.isInteger(Number(sampleLimit)) &&
    Number(sampleLimit) >= 0 &&
    Number(sampleLimit) <= 100
      ? Number(sampleLimit)
      : 10;

  const summary = {
    ok: false,
    dry_run: true,

    source_file:
      path.basename(
        absoluteFilePath
      ),

    source_path:
      absoluteFilePath,

    source_size_bytes:
      Number(fileStat.size || 0),

    source_sha256:
      checksum,

    total_lines_read: 0,
    data_rows_read: 0,
    valid_rows: 0,
    skipped_rows: 0,

    skipped_by_reason: {
      invalid_or_missing_prefix: 0,
      invalid_or_missing_rate: 0,
      malformed_csv_row: 0,
      column_count_mismatch: 0,
    },

    unique_prefixes: 0,
    duplicate_prefix_rows: 0,

    sample_rows: [],
  };

  const prefixCount = new Map();

  const inputStream =
    fs.createReadStream(
      absoluteFilePath,
      {
        encoding: "utf8",
      }
    );

  const lineReader =
    readline.createInterface({
      input: inputStream,
      crlfDelay: Infinity,
    });

  let headerIndex = null;
  let expectedColumnCount = null;

  for await (
    const rawLine of lineReader
  ) {
    summary.total_lines_read += 1;

    if (
      !rawLine ||
      !rawLine.trim()
    ) {
      continue;
    }

    let values;

    try {
      values =
        parseCsvLine(rawLine);
    } catch {
      summary.skipped_rows += 1;

      summary.skipped_by_reason
        .malformed_csv_row += 1;

      continue;
    }

    /*
     * প্রথম non-empty line header।
     */
    if (!headerIndex) {
      headerIndex =
        buildHeaderIndex(values);

      expectedColumnCount =
        values.length;

      continue;
    }

    summary.data_rows_read += 1;

    if (
      values.length !==
      expectedColumnCount
    ) {
      summary.skipped_rows += 1;

      summary.skipped_by_reason
        .column_count_mismatch += 1;

      continue;
    }

    const built =
      buildRow(
        headerIndex,
        values,
        summary.total_lines_read
      );

    if (built.skip) {
      summary.skipped_rows += 1;

      if (
        Object.prototype
          .hasOwnProperty.call(
            summary.skipped_by_reason,
            built.reason
          )
      ) {
        summary.skipped_by_reason[
          built.reason
        ] += 1;
      }

      continue;
    }

    summary.valid_rows += 1;

    const prefix =
      built.row.prefix;

    const previousCount =
      prefixCount.get(prefix) || 0;

    prefixCount.set(
      prefix,
      previousCount + 1
    );

    if (previousCount >= 1) {
      summary.duplicate_prefix_rows += 1;
    }

    if (
      summary.sample_rows.length <
      safeSampleLimit
    ) {
      summary.sample_rows.push(
        built.row
      );
    }
  }

  if (!headerIndex) {
    throw new Error(
      "CSV header row was not found"
    );
  }

  summary.unique_prefixes =
    prefixCount.size;

  summary.ok =
    summary.valid_rows > 0;

  summary.completed_at =
    new Date().toISOString();

  return summary;
}

/**
 * পুরোনো incomplete staging card cleanup।
 *
 * সাধারণ import error transaction rollback হওয়ায় staging row
 * থেকে যাওয়ার কথা নয়।
 *
 * তবুও manual/পুরোনো import থেকে committed staging card থাকলে
 * maintenance command হিসেবে এটি ব্যবহার করা যাবে।
 */
async function cleanupStaleStagingRateCards({
  providerCode = "telnyx",
  olderThanHours = 24,
} = {}) {
  const safeHours =
    Number.isFinite(
      Number(olderThanHours)
    ) &&
    Number(olderThanHours) >= 1
      ? Number(olderThanHours)
      : 24;

  const client =
    await db.pool.connect();

  try {
    await client.query("BEGIN");

    const providerResult =
      await client.query(
        `
        SELECT id, code
        FROM voice_providers
        WHERE code = $1
        LIMIT 1
        `,
        [
          String(providerCode)
            .trim()
            .toLowerCase(),
        ]
      );

    const provider =
      providerResult.rows[0];

    if (!provider) {
      throw new Error(
        `Voice provider not found: ${providerCode}`
      );
    }

    const staleCardsResult =
      await client.query(
        `
        SELECT id
        FROM voice_provider_rate_cards
        WHERE provider_id = $1
          AND is_active = FALSE
          AND metadata->>'import_status'
              = 'staging'
          AND created_at <
              NOW() -
              ($2::text || ' hours')::interval
        FOR UPDATE
        `,
        [
          provider.id,
          safeHours,
        ]
      );

    const staleIds =
      staleCardsResult.rows.map(
        (row) => row.id
      );

    let deletedRates = 0;
    let deletedCards = 0;

    if (staleIds.length > 0) {
      const deletedRateResult =
        await client.query(
          `
          DELETE FROM voice_provider_rates
          WHERE rate_card_id =
            ANY($1::bigint[])
          `,
          [staleIds]
        );

      deletedRates =
        deletedRateResult.rowCount;

      const deletedCardResult =
        await client.query(
          `
          DELETE FROM voice_provider_rate_cards
          WHERE id =
            ANY($1::bigint[])
          `,
          [staleIds]
        );

      deletedCards =
        deletedCardResult.rowCount;
    }

    await client.query("COMMIT");

    return {
      ok: true,

      provider_code:
        provider.code,

      older_than_hours:
        safeHours,

      stale_cards_found:
        staleIds.length,

      deleted_rates:
        deletedRates,

      deleted_rate_cards:
        deletedCards,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Original error preserve করা হচ্ছে।
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Public exports
 *
 * সাধারণ ব্যবহারে:
 * - validateProviderRateDeckFile()
 * - importAndActivateProviderRateDeck()
 *
 * ব্যবহার করবেন।
 */
module.exports = {
  validateProviderRateDeckFile,
  importAndActivateProviderRateDeck,
  cleanupStaleStagingRateCards,

  /*
   * নিচের export গুলো advanced/admin testing-এর জন্য।
   */
  importProviderRateDeck,
  finalizeProviderRateDeckImport,
  parseCsvLine,
  normalizePrefix,
};

/* =========================================================
 * PART-4 END
 * provider-rate-import.service.js file complete
 * ========================================================= */