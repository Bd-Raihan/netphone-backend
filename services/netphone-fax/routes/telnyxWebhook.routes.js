const express = require("express");
const router = express.Router();

const {
  telnyxStatusWebhook,
} = require("../controllers/telnyxWebhook.controller");

// Telnyx outbound fax status webhook
router.post("/telnyx-status", telnyxStatusWebhook);

module.exports = router;