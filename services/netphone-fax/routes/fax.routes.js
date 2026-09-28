const express = require("express");
const router = express.Router();

const {
  createFax,
} = require("../controllers/fax.controller");

// Create outbound fax record
router.post("/send", createFax);

module.exports = router;