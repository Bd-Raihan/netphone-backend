const express = require("express");
const { authRequired, requireAdmin } = require("../auth/middlewares/auth.jwt");
const controller = require("./admin.profit.controller");

const router = express.Router();

router.use(authRequired);
router.use(requireAdmin);

router.get("/dashboard", controller.dashboard);

module.exports = router;