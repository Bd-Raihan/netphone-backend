const express = require("express");

const authRequired = require("../auth/middlewares/auth.jwt");
const adminAuth = require("../../middlewares/adminAuth");
const controller = require("./admin.crypto.controller");

const router = express.Router();

router.use(authRequired);
router.use(adminAuth);

router.get("/pending", controller.getPendingRecharges);
router.post("/:id/approve", controller.approveRecharge);
router.post("/:id/reject", controller.rejectRecharge);

module.exports = router;