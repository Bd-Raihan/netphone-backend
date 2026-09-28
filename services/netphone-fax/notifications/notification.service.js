const db = require("../database/db");

/**
 * Create a fax notification for a user.
 */
async function createNotification({
  userId,
  faxId = null,
  title,
  message = null,
  notificationType = "fax",
}) {
  if (!userId || !title) {
    throw new Error("userId and title are required");
  }

  const result = await db.query(
    `INSERT INTO netphone_fax_notifications
     (
       user_id,
       fax_id,
       title,
       message,
       notification_type
     )
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      userId,
      faxId,
      title,
      message,
      notificationType,
    ]
  );

  return result.rows[0];
}

/**
 * Get all notifications for one user.
 */
async function getUserNotifications(userId) {
  const result = await db.query(
    `SELECT
       id,
       user_id,
       fax_id,
       title,
       message,
       notification_type,
       is_read,
       created_at
     FROM netphone_fax_notifications
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  return result.rows;
}

/**
 * Mark one notification as read.
 */
async function markNotificationAsRead(notificationId, userId) {
  const result = await db.query(
    `UPDATE netphone_fax_notifications
     SET is_read = TRUE
     WHERE id = $1
       AND user_id = $2
     RETURNING *`,
    [notificationId, userId]
  );

  return result.rows[0] || null;
}

module.exports = {
  createNotification,
  getUserNotifications,
  markNotificationAsRead,
};