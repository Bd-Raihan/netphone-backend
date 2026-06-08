const express = require("express");

const {
  authRequired,
} = require("../auth/middlewares/auth.jwt");

const controller =
  require("./crypto.controller");

const router =
  express.Router();


/// ===================================
/// CREATE CRYPTO PAYMENT
/// ===================================
router.post(
  "/create",
  authRequired,
  controller.createCryptoPayment
);


/// ===================================
/// CRYPTO WEBHOOK
/// ===================================
router.post(
  "/webhook",
  controller.cryptoWebhook
);

module.exports = router;