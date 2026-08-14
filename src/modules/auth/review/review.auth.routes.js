/**
 * review.auth.routes.js
 *
 * Separate Google Play review login route.
 */

const express = require("express");
const router = express.Router();

const { reviewLogin } = require("./review.auth.controller");

// Final URL after mounting from auth.routes.js:
// POST /api/auth/review-login
router.post("/", reviewLogin);

module.exports = router;
