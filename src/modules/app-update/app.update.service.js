const db = require("../../config/db");

// ============================================================
// 🇧🇩 APP UPDATE SERVICE
//
// কাজ:
// - Latest active Android release বের করা
// - Admin থেকে নতুন update notice publish করা
// - পুরোনো active notice deactivate করা
//
// Calling / Wallet / Payment-এর সাথে সম্পর্ক নেই.
// ============================================================

function normalizePlatform(value) {
  const platform = String(value || "android")
    .trim()
    .toLowerCase();

  if (!["android"].includes(platform)) {
    throw new Error("unsupported_platform");
  }

  return platform;
}

function normalizePositiveInt(value, fieldName) {
  const number = Number.parseInt(
    String(value ?? ""),
    10,
  );

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${fieldName}_invalid`);
  }

  return number;
}

function normalizeOptionalPositiveInt(
  value,
  fieldName,
) {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    return null;
  }

  return normalizePositiveInt(
    value,
    fieldName,
  );
}

async function getLatestUpdate({
  platform = "android",
} = {}) {
  const normalizedPlatform =
    normalizePlatform(platform);

  const result = await db.query(
    `
      SELECT
        id,
        platform,
        version_name,
        build_number,
        minimum_supported_version_name,
        minimum_supported_build_number,
        title,
        message,
        play_store_url,
        force_update,
        is_active,
        published_at,
        created_at,
        updated_at
      FROM app_update_notifications
      WHERE
        platform = $1
        AND is_active = TRUE
      ORDER BY
        build_number DESC,
        id DESC
      LIMIT 1
    `,
    [normalizedPlatform],
  );

  return result.rows[0] || null;
}

async function publishUpdate({
  platform = "android",
  versionName,
  buildNumber,
  minimumSupportedVersionName = null,
  minimumSupportedBuildNumber = null,
  title,
  message,
  playStoreUrl = null,
  forceUpdate = false,
}) {
  const normalizedPlatform =
    normalizePlatform(platform);

  const normalizedVersionName =
    String(versionName || "").trim();

  const normalizedBuildNumber =
    normalizePositiveInt(
      buildNumber,
      "build_number",
    );

  const normalizedMinBuild =
    normalizeOptionalPositiveInt(
      minimumSupportedBuildNumber,
      "minimum_supported_build_number",
    );

  const normalizedTitle =
    String(title || "").trim();

  const normalizedMessage =
    String(message || "").trim();

  const normalizedPlayStoreUrl =
    String(playStoreUrl || "").trim() || null;

  const normalizedMinVersion =
    String(
      minimumSupportedVersionName || "",
    ).trim() || null;

  if (!normalizedVersionName) {
    throw new Error("version_name_required");
  }

  if (!normalizedTitle) {
    throw new Error("title_required");
  }

  if (!normalizedMessage) {
    throw new Error("message_required");
  }

  const client = await db.getClient();

  try {
    await client.query("BEGIN");

    await client.query(
      `
        UPDATE app_update_notifications
        SET
          is_active = FALSE,
          updated_at = NOW()
        WHERE
          platform = $1
          AND is_active = TRUE
      `,
      [normalizedPlatform],
    );

    const insertResult =
      await client.query(
        `
          INSERT INTO app_update_notifications
          (
            platform,
            version_name,
            build_number,
            minimum_supported_version_name,
            minimum_supported_build_number,
            title,
            message,
            play_store_url,
            force_update,
            is_active,
            published_at,
            created_at,
            updated_at
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            TRUE,
            NOW(),
            NOW(),
            NOW()
          )
          RETURNING *
        `,
        [
          normalizedPlatform,
          normalizedVersionName,
          normalizedBuildNumber,
          normalizedMinVersion,
          normalizedMinBuild,
          normalizedTitle,
          normalizedMessage,
          normalizedPlayStoreUrl,
          Boolean(forceUpdate),
        ],
      );

    await client.query("COMMIT");

    return insertResult.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function deactivateUpdate({
  platform = "android",
} = {}) {
  const normalizedPlatform =
    normalizePlatform(platform);

  const result = await db.query(
    `
      UPDATE app_update_notifications
      SET
        is_active = FALSE,
        updated_at = NOW()
      WHERE
        platform = $1
        AND is_active = TRUE
      RETURNING id
    `,
    [normalizedPlatform],
  );

  return {
    deactivated:
      result.rowCount || 0,
  };
}

module.exports = {
  getLatestUpdate,
  publishUpdate,
  deactivateUpdate,
};