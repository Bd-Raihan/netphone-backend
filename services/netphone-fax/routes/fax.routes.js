const express = require("express");
const {faxAuthRequired} = require("../middlewares/faxAuth.middleware");
const {createFax,getFaxHistory} = require("../controllers/fax.controller");
const platform = require("../services/faxPlatform.service");
const router = express.Router();

// Existing send logic is preserved when charging is OFF.
// Charging ON requires a server-generated, owner-bound quote.
router.post("/send",faxAuthRequired,platform.sendOrContinue,createFax);
router.get("/history",faxAuthRequired,getFaxHistory);
platform.installRoutes(router);
module.exports = router;
