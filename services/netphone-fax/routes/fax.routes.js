const express = require("express");
const router = express.Router();

const {
  createFax,
  getFaxHistory,
} = require("../controllers/fax.controller");

// Create outbound fax record
router.post("/send", createFax);

// Get fax history for a specific user
router.get("/history/:userId", getFaxHistory);

module.exports = router;