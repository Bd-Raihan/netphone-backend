"use strict";

const express =
  require("express");

const {
  authRequired,
  requireAdmin,
} = require(
  "../auth/middlewares/auth.jwt"
);

const controller =
  require(
    "./admin.call.activity.controller"
  );

const router =
  express.Router();

// ============================================================
// 🇧🇩 ADMIN CALL ACTIVITY / CDR ROUTES
//
// এই routes শুধুমাত্র authenticated Admin ব্যবহার করতে পারবে।
// Normal user এই report access করতে পারবে না.
// ============================================================

router.use(
  authRequired
);

router.use(
  requireAdmin
);

// Call Activity list + summary
router.get(
  "/",
  controller.list
);

// Single Call Details
router.get(
  "/:id",
  controller.details
);

module.exports =
  router;