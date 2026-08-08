const express = require("express");

const {
  authRequired,
} = require(
  "../auth/middlewares/auth.jwt"
);

const adminAuth = require(
  "../../middlewares/adminAuth"
);

const controller = require(
  "./app.update.controller"
);

const router = express.Router();

// ============================================================
// 🇧🇩 PUBLIC APP UPDATE CHECK
//
// App open হলে current active update notice check করবে.
// Login ছাড়াও কাজ করতে পারবে.
// ============================================================

router.get(
  "/latest",
  controller.getLatestUpdate,
);

// ============================================================
// 🇧🇩 ADMIN APP UPDATE MANAGEMENT
//
// শুধু Admin নতুন update notice publish/deactivate করতে পারবে.
// ============================================================

router.post(
  "/publish",
  authRequired,
  adminAuth,
  controller.publishUpdate,
);

router.post(
  "/deactivate",
  authRequired,
  adminAuth,
  controller.deactivateUpdate,
);

module.exports = router;