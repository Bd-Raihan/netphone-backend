const express = require("express");

const {
  authRequired,
} = require("../auth/middlewares/auth.jwt");

const controller = require("./crypto.controller");

const router = express.Router();
router.get(
  "/config",
  authRequired,
  controller.getCryptoConfig
);
router.post(
  "/recharge-request",
  authRequired,
  controller.createRechargeRequest
);

// User recharge request route
// এই route দিয়ে user নিজের recharge request দেখতে পারবে
router.get(
  "/my-requests",
  authRequired,
  controller.getMyRechargeRequests
);

// User recharge history route
// এই route দিয়ে user নিজের crypto recharge history দেখতে পারবে
router.get(
  "/recharge-history",
  authRequired,
  controller.getMyRechargeRequests
);

router.get(
  "/admin/requests",
  authRequired,
  controller.getAdminRechargeRequests
);

router.post(
  "/admin/requests/:id/approve",
  authRequired,
  controller.approveRechargeRequest
);

router.post(
  "/admin/requests/:id/reject",
  authRequired,
  controller.rejectRechargeRequest
);

router.post(
  "/webhook",
  controller.cryptoWebhook
);

module.exports = router;