/**
 * health.routes.js
 * কাজ: /health route handle করা
 */

const express = require("express");
const router = express.Router();

// ✅ controller থেকে দুইটা ফাংশন আনছি
const { healthCheck, dbHealth } = require("./health.controller"); // ← এখানে ঠিক করা

// GET /health
router.get("/", healthCheck);

// GET /health/db
router.get("/db", dbHealth);

module.exports = router;
