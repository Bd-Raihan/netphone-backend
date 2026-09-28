const express = require("express");
const router = express.Router();

const {
  getNotifications,
  markAsRead,
} = require("../controllers/notification.controller");

// Get all fax notifications for a specific user
router.get("/:userId", getNotifications);

// Mark one notification as read
router.patch("/:userId/:notificationId/read", markAsRead);

module.exports = router;