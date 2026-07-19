/**
 * admin-rate-import.routes.js
 * --------------------------------------------------
 * NetPhone Admin Provider Rate Import Routes
 *
 * এই file-এর দায়িত্ব:
 *
 * 1. সব endpoint-এ authenticated admin নিশ্চিত করা
 * 2. Validation middleware প্রয়োগ করা
 * 3. Controller function-এর সঙ্গে endpoint connect করা
 *
 * Final API endpoints:
 *
 * GET
 * /api/admin/rate-import/files?provider=telnyx
 *
 * POST
 * /api/admin/rate-import/validate
 *
 * POST
 * /api/admin/rate-import/import
 */

const express = require("express");

const {
  authRequired,
  requireAdmin,
} = require(
  "../auth/middlewares/auth.jwt"
);

const controller = require(
  "./admin-rate-import.controller"
);

const {
  validateRateDeckSchema,
  importRateDeckSchema,
  validateBody,
} = require(
  "./admin-rate-import.validation"
);

const router = express.Router();

/* =========================================================
 * SECTION 1
 * Admin authentication
 * ========================================================= */

/**
 * Existing Admin Crypto module-এর একই security pattern।
 *
 * প্রথমে valid JWT user নিশ্চিত হবে,
 * তারপর user-এর admin role নিশ্চিত হবে।
 */
router.use(authRequired);
router.use(requireAdmin);

/* =========================================================
 * SECTION 2
 * Available provider CSV files
 * ========================================================= */

/**
 * GET /files?provider=telnyx
 *
 * Provider storage folder-এর available CSV list return করবে।
 *
 * Database পরিবর্তন করবে না।
 */
router.get(
  "/files",
  controller.listRateDeckFiles
);

/* =========================================================
 * SECTION 3
 * CSV validation / dry-run preview
 * ========================================================= */

/**
 * POST /validate
 *
 * Body:
 * {
 *   "provider": "telnyx",
 *   "file": "telnyx_global_conversational.csv",
 *   "sample_limit": 10
 * }
 *
 * Database পরিবর্তন করবে না।
 */
router.post(
  "/validate",
  validateBody(
    validateRateDeckSchema
  ),
  controller.validateRateDeck
);

/* =========================================================
 * SECTION 4
 * Actual rate import and activation
 * ========================================================= */

/**
 * POST /import
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
 * Database-এ rate import এবং card activation করবে।
 */
router.post(
  "/import",
  validateBody(
    importRateDeckSchema
  ),
  controller.importRateDeck
);

module.exports = router;