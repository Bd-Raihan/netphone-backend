const express = require("express");

const { authRequired, requireAdmin } = require("../auth/middlewares/auth.jwt");
const controller = require("./admin.crypto.controller");

const router = express.Router();

router.use(authRequired);
router.use(requireAdmin);

router.get("/pending", controller.getPendingRecharges);
router.post("/:id/approve", controller.approveRecharge);
router.post("/:id/reject", controller.rejectRecharge);

module.exports = router;