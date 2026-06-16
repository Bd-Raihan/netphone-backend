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

router.get(
  "/my-requests",
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