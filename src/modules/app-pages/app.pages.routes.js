const express = require("express");
const controller = require("./app.pages.controller");

const router = express.Router();

router.get("/", controller.listPages);
router.get("/:slug", controller.getPage);

module.exports = router;