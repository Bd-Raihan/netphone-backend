const express = require("express");
const controller = require("./rates.controller");

const router = express.Router();

router.get("/", controller.listRates);

module.exports = router;