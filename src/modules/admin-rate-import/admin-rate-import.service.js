/**
 * admin-rate-import.service.js
 * --------------------------------------------------
 * NetPhone Admin Provider Rate Import Service
 *
 * এই file-এর দায়িত্ব:
 *
 * 1. Provider rate-deck storage folder নিরাপদভাবে resolve করা
 * 2. কোনো user-supplied absolute path গ্রহণ না করা
 * 3. Path traversal attack প্রতিরোধ করা
 * 4. Provider folder-এর CSV file list করা
 * 5. CSV dry-run validation চালানো
 * 6. CSV import ও rate-card activation চালানো
 * 7. Import result API-friendly format-এ return করা
 *
 * Storage structure:
 *
 * project-root/
 * └── storage/
 *     └── provider-rate-decks/
 *         ├── telnyx/
 *         ├── bangladesh-provider/
 *         └── future-provider/
 */

const fs = require("fs");
const path = require("path");

const providerRateImporter = require(
  "../calls/provider-rate-import.service"
);

/* =========================================================
 * SECTION 1
 * Storage location এবং সাধারণ constants
 * ========================================================= */

/**
 * Backend project root।
 *
 * এই file:
 * src/modules/admin-rate-import/admin-rate-import.service.js
 *
 * তাই project root পেতে তিন level উপরে যেতে হবে।
 */
const PROJECT_ROOT = path.resolve(
  __dirname,
  "../../.."
);

/**
 * সব provider rate deck এই folder-এর নিচে থাকবে।
 */
const RATE_DECK_STORAGE_ROOT = path.join(
  PROJECT_ROOT,
  "storage",
  "provider-rate-decks"
);

/**
 * Provider code-এর নিরাপদ format।
 *
 * গ্রহণযোগ্য:
 * telnyx
 * didww
 * bd-provider
 * provider_1
 */
const SAFE_PROVIDER_CODE_PATTERN =
  /^[a-z][a-z0-9_-]{0,49}$/;

/**
 * CSV filename-এর নিরাপদ format।
 *
 * গ্রহণযোগ্য:
 * telnyx_global_conversational.csv
 *
 * গ্রহণযোগ্য নয়:
 * ../secret.csv
 * folder/file.csv
 * C:\file.csv
 */
const SAFE_CSV_FILE_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.csv$/i;

/* =========================================================
 * SECTION 2
 * Input normalization এবং path security
 * ========================================================= */

/**
 * Provider code normalize করে।
 */
function normalizeProviderCode(providerCode) {
  const normalized = String(
    providerCode || ""
  )
    .trim()
    .toLowerCase();

  if (
    !SAFE_PROVIDER_CODE_PATTERN.test(
      normalized
    )
  ) {
    const error = new Error(
      "Invalid provider code"
    );

    error.statusCode = 400;
    error.code = "INVALID_PROVIDER_CODE";

    throw error;
  }

  return normalized;
}

/**
 * Plan code normalize করে।
 */
function normalizePlanCode(planCode) {
  const normalized = String(
    planCode || ""
  )
    .trim()
    .toLowerCase();

  if (
    !SAFE_PROVIDER_CODE_PATTERN.test(
      normalized
    )
  ) {
    const error = new Error(
      "Invalid provider plan code"
    );

    error.statusCode = 400;
    error.code = "INVALID_PLAN_CODE";

    throw error;
  }

  return normalized;
}

/**
 * Plain CSV filename validate করে।
 *
 * Validation middleware থাকলেও Service layer-এ আবার check করা হচ্ছে,
 * কারণ business/service layer নিজেও নিরাপদ থাকা উচিত।
 */
function normalizeCsvFileName(fileName) {
  const normalized = String(
    fileName || ""
  ).trim();

  if (
    !SAFE_CSV_FILE_PATTERN.test(
      normalized
    ) ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized === "." ||
    normalized === ".."
  ) {
    const error = new Error(
      "Invalid CSV filename"
    );

    error.statusCode = 400;
    error.code = "INVALID_CSV_FILENAME";

    throw error;
  }

  return normalized;
}

/**
 * কোনো resolved child path সত্যিই parent folder-এর ভিতরে আছে কি না
 * পরীক্ষা করে।
 *
 * এটি path traversal protection-এর দ্বিতীয় স্তর।
 */
function assertPathInsideParent(
  parentPath,
  childPath
) {
  const relativePath = path.relative(
    parentPath,
    childPath
  );

  const isOutside =
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath);

  if (isOutside) {
    const error = new Error(
      "Resolved rate-deck path is outside the allowed storage folder"
    );

    error.statusCode = 400;
    error.code = "UNSAFE_RATE_DECK_PATH";

    throw error;
  }
}

/**
 * Provider folder resolve করে।
 */
function resolveProviderFolder(
  providerCode
) {
  const provider =
    normalizeProviderCode(providerCode);

  const providerFolder = path.resolve(
    RATE_DECK_STORAGE_ROOT,
    provider
  );

  assertPathInsideParent(
    RATE_DECK_STORAGE_ROOT,
    providerFolder
  );

  return {
    provider,
    providerFolder,
  };
}

/**
 * Provider + filename থেকে secure absolute CSV path তৈরি করে।
 */
function resolveRateDeckPath({
  providerCode,
  fileName,
}) {
  const {
    provider,
    providerFolder,
  } = resolveProviderFolder(
    providerCode
  );

  const file =
    normalizeCsvFileName(fileName);

  const absoluteFilePath = path.resolve(
    providerFolder,
    file
  );

  assertPathInsideParent(
    providerFolder,
    absoluteFilePath
  );

  return {
    provider,
    file,
    providerFolder,
    absoluteFilePath,
  };
}

/* =========================================================
 * SECTION 3
 * Filesystem validation
 * ========================================================= */

/**
 * Provider folder exists কি না নিশ্চিত করে।
 */
async function assertProviderFolderExists(
  providerFolder
) {
  let folderStat;

  try {
    folderStat = await fs.promises.stat(
      providerFolder
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      const notFoundError = new Error(
        "Provider rate-deck folder was not found"
      );

      notFoundError.statusCode = 404;
      notFoundError.code =
        "PROVIDER_FOLDER_NOT_FOUND";

      throw notFoundError;
    }

    throw error;
  }

  if (!folderStat.isDirectory()) {
    const error = new Error(
      "Provider rate-deck path is not a directory"
    );

    error.statusCode = 500;
    error.code =
      "INVALID_PROVIDER_STORAGE";

    throw error;
  }
}

/**
 * CSV file exists এবং regular file কি না নিশ্চিত করে।
 */
async function getRateDeckFileInfo(
  absoluteFilePath
) {
  let fileStat;

  try {
    fileStat = await fs.promises.stat(
      absoluteFilePath
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      const notFoundError = new Error(
        "Provider rate-deck CSV file was not found"
      );

      notFoundError.statusCode = 404;
      notFoundError.code =
        "RATE_DECK_FILE_NOT_FOUND";

      throw notFoundError;
    }

    throw error;
  }

  if (!fileStat.isFile()) {
    const error = new Error(
      "Selected rate-deck path is not a file"
    );

    error.statusCode = 400;
    error.code =
      "RATE_DECK_NOT_A_FILE";

    throw error;
  }

  if (fileStat.size <= 0) {
    const error = new Error(
      "Selected rate-deck CSV file is empty"
    );

    error.statusCode = 400;
    error.code =
      "RATE_DECK_FILE_EMPTY";

    throw error;
  }

  return {
    size_bytes: Number(
      fileStat.size || 0
    ),

    modified_at:
      fileStat.mtime?.toISOString() ||
      null,
  };
}

/* =========================================================
 * SECTION 4
 * Provider rate-deck file listing
 * ========================================================= */

/**
 * নির্দিষ্ট provider folder-এর available CSV file list করে।
 *
 * Admin Panel-এর dropdown-এ এই data ব্যবহার করা যাবে।
 */
async function listProviderRateDeckFiles({
  providerCode = "telnyx",
} = {}) {
  const {
    provider,
    providerFolder,
  } = resolveProviderFolder(
    providerCode
  );

  await assertProviderFolderExists(
    providerFolder
  );

  const entries =
    await fs.promises.readdir(
      providerFolder,
      {
        withFileTypes: true,
      }
    );

  const files = [];

  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !SAFE_CSV_FILE_PATTERN.test(
        entry.name
      )
    ) {
      continue;
    }

    const absoluteFilePath = path.join(
      providerFolder,
      entry.name
    );

    const fileInfo =
      await getRateDeckFileInfo(
        absoluteFilePath
      );

    files.push({
      file: entry.name,

      size_bytes:
        fileInfo.size_bytes,

      modified_at:
        fileInfo.modified_at,
    });
  }

  files.sort(
    (first, second) =>
      String(second.modified_at || "")
        .localeCompare(
          String(first.modified_at || "")
        )
  );

  return {
    provider,
    storage_folder:
      path.relative(
        PROJECT_ROOT,
        providerFolder
      ),

    total_files: files.length,
    files,
  };
}

/* =========================================================
 * SECTION 5
 * Read-only CSV validation/preview
 * ========================================================= */

/**
 * CSV dry-run validation চালায়।
 *
 * গুরুত্বপূর্ণ:
 * এটি database-এ কোনো data insert/update/delete করবে না।
 */
async function validateProviderRateDeck({
  providerCode = "telnyx",
  fileName,
  sampleLimit = 10,
} = {}) {
  const resolved = resolveRateDeckPath({
    providerCode,
    fileName,
  });

  await assertProviderFolderExists(
    resolved.providerFolder
  );

  const fileInfo =
    await getRateDeckFileInfo(
      resolved.absoluteFilePath
    );

  const validationResult =
    await providerRateImporter
      .validateProviderRateDeckFile({
        filePath:
          resolved.absoluteFilePath,

        sampleLimit,
      });

  return {
    ...validationResult,

    provider_code:
      resolved.provider,

    requested_file:
      resolved.file,

    file_info: fileInfo,
  };
}

/* =========================================================
 * SECTION 6
 * Actual import এবং rate-card activation
 * ========================================================= */

/**
 * CSV import করে এবং নতুন provider rate card activate করে।
 *
 * Importer নিজে:
 * - transaction ব্যবহার করে
 * - checksum duplicate detect করে
 * - staging card তৈরি করে
 * - valid rates import করে
 * - previous card deactivate করে
 * - new card activate করে
 */
async function importProviderRateDeck({
  providerCode = "telnyx",
  planCode = "payg",
  fileName,
  batchSize = 500,
  allowDuplicateChecksum = false,
  adminUserId = null,
} = {}) {
  const resolved = resolveRateDeckPath({
    providerCode,
    fileName,
  });

  const normalizedPlan =
    normalizePlanCode(planCode);

  await assertProviderFolderExists(
    resolved.providerFolder
  );

  const fileInfo =
    await getRateDeckFileInfo(
      resolved.absoluteFilePath
    );

  const result =
    await providerRateImporter
      .importAndActivateProviderRateDeck({
        filePath:
          resolved.absoluteFilePath,

        providerCode:
          resolved.provider,

        planCode:
          normalizedPlan,

        batchSize:
          Number(batchSize),

        allowDuplicateChecksum:
          Boolean(
            allowDuplicateChecksum
          ),
      });

  return {
    ...result,

    requested_by_admin_user_id:
      adminUserId || null,

    requested_provider:
      resolved.provider,

    requested_plan:
      normalizedPlan,

    requested_file:
      resolved.file,

    file_info: fileInfo,
  };
}

/* =========================================================
 * SECTION 7
 * Public exports
 * ========================================================= */

module.exports = {
  listProviderRateDeckFiles,
  validateProviderRateDeck,
  importProviderRateDeck,

  /*
   * নিচের helpers testing/debugging-এর জন্য export করা হয়েছে।
   */
  resolveProviderFolder,
  resolveRateDeckPath,
};