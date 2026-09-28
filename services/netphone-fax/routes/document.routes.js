const express = require("express");

const {
  faxAuthRequired,
} = require("../middlewares/faxAuth.middleware");

const {
  viewFaxDocument,
  downloadFaxDocument,
} = require("../controllers/document.controller");

const router = express.Router();

router.get(
  "/documents/:faxId/view",
  faxAuthRequired,
  viewFaxDocument
);

router.get(
  "/documents/:faxId/download",
  faxAuthRequired,
  downloadFaxDocument
);

module.exports = router;