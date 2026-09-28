const {
  getUserNotifications,
  markNotificationAsRead,
} = require("../notifications/notification.service");

async function getNotifications(req, res) {
  try {
    const userId = Number(req.user?.id);

    if (
      !Number.isInteger(userId) ||
      userId <= 0
    ) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const notifications =
      await getUserNotifications(userId);

    return res.status(200).json({
      success: true,
      count: notifications.length,
      notifications,
    });
  } catch (error) {
    console.error(
      "Get Notifications Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Unable to get notifications",
    });
  }
}

async function markAsRead(req, res) {
  try {
    const userId = Number(req.user?.id);
    const notificationId =
      Number(req.params.notificationId);

    if (
      !Number.isInteger(userId) ||
      userId <= 0
    ) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (
      !Number.isInteger(notificationId) ||
      notificationId <= 0
    ) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    const notification =
      await markNotificationAsRead(
        notificationId,
        userId
      );

    // Do not reveal whether another user's
    // notification exists.
    if (!notification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    return res.status(200).json({
      success: true,
      message:
        "Notification marked as read",
      notification,
    });
  } catch (error) {
    console.error(
      "Mark Notification Read Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to update notification",
    });
  }
}

module.exports = {
  getNotifications,
  markAsRead,
};