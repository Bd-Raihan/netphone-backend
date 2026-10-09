
"use strict";

const express = require("express");
const { handleStripeWebhook } = require("./stripe.webhook.controller");

const router = express.Router();

router.post("/", handleStripeWebhook);

module.exports = router;
