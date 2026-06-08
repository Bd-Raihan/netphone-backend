/**
 * countries.routes.js
 * কাজ: country related route গুলো define করা
 */

const express = require("express");
const router = express.Router();

const requireAdmin = require("../../middlewares/requireAdmin");
const {
  listCountries,
  listActiveCountries,
  toggleCountry,
  getCountryRate,
  updateCountryRate,
} = require("./countries.controller");

// ✅ Public (App user) routes
router.get("/", listCountries);
router.get("/active", listActiveCountries);
router.get("/:code/rate", getCountryRate);

// ✅ Admin routes (secure)
router.patch("/:code/toggle", requireAdmin, toggleCountry);
router.patch("/:code/rate", requireAdmin, updateCountryRate);

module.exports = router;
