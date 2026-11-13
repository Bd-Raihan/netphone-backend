const express = require("express");
const controller = require("./rates.controller");

const router = express.Router();

router.get("/calling-period", async (req, res, next) => {
  try {
    // The admin reporting period must never hide user Recents.
    res.set("Cache-Control", "no-store").json({ok:true, started_at:null});
  } catch (error) { next(error); }
});
router.get("/", controller.listRates);

module.exports = router;