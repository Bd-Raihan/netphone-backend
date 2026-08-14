/**
 * auth.routes.js
 * কাজ:
 * - /auth routes define করা
 */

/// External Modules
const express = require("express");
const router = express.Router();

const { requestOtp, verifyOtpAndLogin } = require("./auth.controller");
const reviewAuthRoutes = require("./review/review.auth.routes");

// ✅ POST /auth/request-otp
router.post("/request-otp", requestOtp);

// ✅ POST /auth/verify-otp
router.post("/verify-otp", verifyOtpAndLogin);

// ✅ Google Play review login (separate from OTP)
router.use("/review-login", reviewAuthRoutes);

module.exports = router;
