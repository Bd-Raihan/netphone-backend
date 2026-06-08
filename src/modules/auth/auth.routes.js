/**
 * auth.routes.js
 * কাজ:
 * - /auth routes define করা
 */

/// External Modules
const express = require("express");
const router = express.Router();

const { requestOtp, verifyOtpAndLogin } = require("./auth.controller");

// ✅ POST /auth/request-otp
router.post("/request-otp", requestOtp);

// ✅ POST /auth/verify-otp
router.post("/verify-otp", verifyOtpAndLogin);

module.exports = router;
