const {
  getUserNotifications,
  markNotificationAsRead,
} = require("../notifications/notification.service");

/**
 * Get all fax notifications for a user
 */
async function getNotifications(req, res) {
  try {
    const userId = req.params.userId;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const notifications = await getUserNotifications(userId);

    return res.status(200).json({
      success: true,
      count: notifications.length,
      notifications,
    });
  } catch (error) {
    console.error("Get Notifications Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to get notifications",
    });
  }
}

/**
 * Mark one notification as read
 */
async function markAsRead(req, res) {
  try {
    const { userId, notificationId } = req.params;

    if (!userId || !notificationId) {
      return res.status(400).json({
        success: false,
        message: "userId and notificationId are required",
      });
    }

    const notification = await markNotificationAsRead(
      notificationId,
      userId
    );

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Notification marked as read",
      notification,
    });
  } catch (error) {
    console.error("Mark Notification Read Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to update notification",
    });
  }
}

module.exports = {
  getNotifications,
  markAsRead,
};