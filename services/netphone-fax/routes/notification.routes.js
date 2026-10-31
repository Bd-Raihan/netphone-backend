const express = require("express");

const {
  faxAuthRequired,
} = require("../middlewares/faxAuth.middleware");

const {
  getNotifications,
  markAsRead,
} = require("../controllers/notification.controller");

const router = express.Router();

router.get(
  "/",
  faxAuthRequired,
  getNotifications
);

router.patch(
  "/:notificationId/read",
  faxAuthRequired,
  markAsRead
);

require('../services/faxListCleanup.service').installNotifications(router,faxAuthRequired,require('../database/db'));
module.exports = router;