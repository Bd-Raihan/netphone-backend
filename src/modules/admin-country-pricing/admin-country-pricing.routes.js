const express =
  require("express");

const {
  authRequired,
  requireAdmin,
} =
  require(
    "../auth/middlewares/auth.jwt"
  );

const controller =
  require(
    "./admin-country-pricing.controller"
  );

const router =
  express.Router();

router.use(authRequired);
router.use(requireAdmin);

/*
 * GET /api/admin/country-pricing
 *
 * Optional:
 * ?search=Bangladesh
 */
router.get(
  "/",
  controller.list
);

/*
 * GET /api/admin/country-pricing/880
 */
router.get(
  "/:prefix",
  controller.getOne
);

/*
 * PUT /api/admin/country-pricing/880
 *
 * Auto mode:
 * {
 *   "pricing_mode": "auto_markup",
 *   "markup_percent": 90
 * }
 *
 * Manual mode:
 * {
 *   "pricing_mode": "manual_rate",
 *   "manual_sell_rate_usd_per_min": 0.02513
 * }
 */
router.put(
  "/:prefix",
  controller.update
);

/*
 * DELETE
 * /api/admin/country-pricing/880/override
 *
 * Manual override বন্ধ করে
 * automatic route pricing-এ ফেরত যাবে।
 */
router.delete(
  "/:prefix/override",
  controller.disableOverride
);

module.exports = router;