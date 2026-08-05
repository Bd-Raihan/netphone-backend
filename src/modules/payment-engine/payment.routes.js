"use strict";

const express = require("express");
const router = express.Router();

const {
  authRequired,
} = require("../auth/middlewares/auth.jwt");

const controller = require(
  "./payment.controller"
);

/**
 * Public/Authenticated provider information
 *
 * Authentication রাখা হয়েছে যাতে production payment
 * configuration anonymousভাবে expose না হয়।
 */
router.get(
  "/providers",
  authRequired,
  controller.listProviders
);

router.get(
  "/methods/:provider",
  authRequired,
  controller.listMethods
);

/**
 * Payment order create
 */
router.post(
  "/orders",
  authRequired,
  controller.createOrder
);

/**
 * User payment order history
 */
router.get(
  "/orders",
  authRequired,
  controller.listMyOrders
);

/**
 * Dedicated crypto transaction history
 *
 * এটি /orders/:reference-এর আগে রাখা হয়েছে,
 * যাতে "history" reference হিসেবে match না হয়।
 */
router.get(
  "/history",
  authRequired,
  controller.listMyCryptoHistory
);

/**
 * User submits Binance On-chain TX hash
 */
router.post(
  "/orders/:reference/tx-hash",
  authRequired,
  controller.submitTxHash
);

/**
 * User submits Binance Pay transaction ID
 */
router.post(
  "/orders/:reference/binance-pay-transaction",
  authRequired,
  controller.submitBinancePayTransaction
);

/**
 * Single payment order
 *
 * Dynamic :reference route সব fixed routes-এর পরে থাকবে।
 */
router.get(
  "/orders/:reference",
  authRequired,
  controller.getMyOrder
);

module.exports = router;