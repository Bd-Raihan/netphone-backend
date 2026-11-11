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
const callingGuard = require('../calling-guard/guard.service');
const costMonitor = require('../calling-guard/cost-monitor');
const guarded = fn => async (req,res) => {
 try {res.json({ok:true,data:await fn(req)});} catch(e) {res.status(e.statusCode||503).json({ok:false,message:e.message});}
};
// These literal paths must precede /:prefix. Both JWT and Admin checks remain above.
router.get('/guard/status',guarded(()=>callingGuard.health()));
router.post('/guard/sync',guarded(()=>costMonitor.sync()));
router.patch('/guard/enabled',guarded(req=>callingGuard.enable(req.body.enabled,req.user.id)));
router.post('/guard/resolve-alert',guarded(req=>callingGuard.resolveAlert(String(req.body.alert_key||''),req.user.id)));
router.patch('/guard/config',guarded(req=>callingGuard.configure(req.body,req.user.id)));
router.put('/:prefix/route-policy',guarded(req=>callingGuard.saveRoutePolicy({prefix:req.params.prefix,adminUserId:req.user.id,payload:req.body})));
router.get('/:prefix/routes',guarded(req=>callingGuard.routeRows(req.params.prefix,req.query)));


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