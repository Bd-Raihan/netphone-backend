/**
 * admin-rate-import.controller.js
 * --------------------------------------------------
 * NetPhone Admin Rate Import Controller
 *
 * এই file-এর দায়িত্ব:
 *
 * 1. Admin request গ্রহণ করা
 * 2. validated request data service-এ পাঠানো
 * 3. CSV file list return করা
 * 4. CSV preview/dry-run result return করা
 * 5. Actual import result return করা
 * 6. Service error-কে নিরাপদ HTTP response-এ convert করা
 */

const adminRateImportService = require(
  "./admin-rate-import.service"
);

/**
 * Service error-এর জন্য consistent API response।
 */
function sendServiceError(
  res,
  error,
  fallbackMessage
) {
  console.error(
    "❌ ADMIN RATE IMPORT ERROR:",
    error
  );

  return res
    .status(error.statusCode || 500)
    .json({
      ok: false,

      code:
        error.code ||
        "ADMIN_RATE_IMPORT_ERROR",

      message:
        error.message ||
        fallbackMessage,
    });
}

/**
 * GET /api/admin/rate-import/files
 *
 * Query:
 * ?provider=telnyx
 *
 * নির্দিষ্ট provider folder-এর available CSV file list দেয়।
 */
async function listRateDeckFiles(
  req,
  res
) {
  try {
    const providerCode =
      String(
        req.query?.provider || "telnyx"
      )
        .trim()
        .toLowerCase();

    const result =
      await adminRateImportService
        .listProviderRateDeckFiles({
          providerCode,
        });

    return res.json({
      ok: true,
      data: result,
    });
  } catch (error) {
    return sendServiceError(
      res,
      error,
      "Failed to list provider rate-deck files"
    );
  }
}

/**
 * POST /api/admin/rate-import/validate
 *
 * Body:
 * {
 *   "provider": "telnyx",
 *   "file": "telnyx_global_conversational.csv",
 *   "sample_limit": 10
 * }
 *
 * Database পরিবর্তন না করে CSV preview/dry-run চালায়।
 */
async function validateRateDeck(
  req,
  res
) {
  try {
    const data =
      req.validatedBody ||
      req.body ||
      {};

    const result =
      await adminRateImportService
        .validateProviderRateDeck({
          providerCode:
            data.provider,

          fileName:
            data.file,

          sampleLimit:
            data.sample_limit,
        });

    return res.json({
      ok: true,

      message:
        "Rate deck validation completed successfully",

      data: result,
    });
  } catch (error) {
    return sendServiceError(
      res,
      error,
      "Failed to validate provider rate deck"
    );
  }
}

/**
 * POST /api/admin/rate-import/import
 *
 * Body:
 * {
 *   "provider": "telnyx",
 *   "plan": "payg",
 *   "file": "telnyx_global_conversational.csv",
 *   "batch_size": 500,
 *   "allow_duplicate_checksum": false
 * }
 *
 * Actual CSV import এবং rate-card activation চালায়।
 */
async function importRateDeck(
  req,
  res
) {
  try {
    const data =
      req.validatedBody ||
      req.body ||
      {};

    const adminUserId =
      req.user?.id || null;

    const result =
      await adminRateImportService
        .importProviderRateDeck({
          providerCode:
            data.provider,

          planCode:
            data.plan,

          fileName:
            data.file,

          batchSize:
            data.batch_size,

          allowDuplicateChecksum:
            data.allow_duplicate_checksum,

          adminUserId,
        });

    return res.status(201).json({
      ok: true,

      message:
        result.duplicate_import === true
          ? "Rate deck was already imported"
          : "Rate deck imported and activated successfully",

      data: result,
    });
  } catch (error) {
    return sendServiceError(
      res,
      error,
      "Failed to import provider rate deck"
    );
  }
}

module.exports = {
  listRateDeckFiles,
  validateRateDeck,
  importRateDeck,
};