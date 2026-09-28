const express = require("express");

const {
  serveTelnyxMedia,
} = require("../controllers/media.controller");

const router = express.Router();

router.get(
  "/media/:token",
  serveTelnyxMedia
);

module.exports = router;