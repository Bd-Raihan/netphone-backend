const express = require("express");
const router = express.Router();

const {
  authRequired,
  requireAdmin,
} = require("../auth/middlewares/auth.jwt");

const controller = require("./wallet.controller");

/// User wallet
router.get("/me", authRequired, controller.me);
router.get("/tx", authRequired, controller.tx);

/// Admin recharge
router.post("/credit", authRequired, requireAdmin, controller.credit);

/// System debit
router.post("/debit", authRequired, controller.debit);

/// POST /wallet/transfer
/// User → User balance transfer
/// ===============================
router.post(
  "/transfer",
  authRequired,
  controller.transferBalance
);


module.exports = router; // Export the router