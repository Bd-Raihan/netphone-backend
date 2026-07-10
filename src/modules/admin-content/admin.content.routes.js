const express = require("express");

const {
  authRequired,
  requireAdmin,
} = require("../auth/middlewares/auth.jwt");

const controller = require("./admin.content.controller");

const router = express.Router();

router.use(authRequired);
router.use(requireAdmin);

router.get("/pages", controller.getAllPages);
router.get("/pages/:id", controller.getPageById);
router.post("/pages", controller.createPage);
router.put("/pages/:id", controller.updatePage);
router.delete("/pages/:id", controller.deletePage);

module.exports = router;