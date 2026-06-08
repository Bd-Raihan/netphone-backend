const express = require("express");

const router = express.Router();

const controller =
  require("./payment.controller");

const {
  authRequired,
} = require("../auth/middlewares/auth.jwt");


/// =======================================
/// CREATE PAYMENT
/// =======================================
router.post(
  "/create",
  authRequired,
  controller.createPayment
);


/// =======================================
/// PAYMENT WEBHOOK
/// =======================================
router.post(
  "/webhook",
  controller.paymentWebhook
);

module.exports = router;