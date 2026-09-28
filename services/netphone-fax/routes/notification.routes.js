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

module.exports = router;