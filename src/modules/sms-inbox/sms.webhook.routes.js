"use strict";

const express = require("express");
const controller = require("./sms.webhook.controller");

const router = express.Router();

router.post("/", controller.receive);

module.exports = router;