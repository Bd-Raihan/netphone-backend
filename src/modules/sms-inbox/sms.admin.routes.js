"use strict";

const express = require("express");

const {
  authRequired,
  requireAdmin
} = require("../auth/middlewares/auth.jwt");

const controller = require("./sms.admin.controller");
const { startSmsCleanup } = require("./sms.cleanup");

const router = express.Router();

router.use(authRequired);
router.use(requireAdmin);

startSmsCleanup();

router.get("/", controller.list);

module.exports = router;