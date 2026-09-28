const db = require("../database/db");

const {
  createNotification,
} = require("../notifications/notification.service");

function getEventData(event) {
  const eventType =
    event?.data?.event_type ||
    event?.event_type ||
    "unknown";

  const payload =
    event?.data?.payload ||
    event?.payload ||
    {};

  const faxId =
    payload?.fax_id ||
    payload?.id ||
    event?.data?.id ||
    null;

  return {
    eventType,
    payload,
    faxId,
  };
}

async function telnyxStatusWebhook(req, res) {
  try {
    const event = req.body || {};

    const {
      eventType,
      payload,
      faxId,
    } = getEventData(event);

    console.log(
      `[NETPHONE FAX STATUS] event=${eventType} faxId=${faxId || "unknown"}`
    );

    /*
     * Important:
     * This endpoint is only for outbound fax status events.
     * Inbound fax.received continues to be handled by the
     * existing fax-receiver service.
     */
    if (eventType === "fax.received") {
      return res.status(200).json({
        received: true,
        ignored: true,
        reason: "Inbound fax is handled by the existing receiver",
      });
    }

    if (!faxId) {
      return res.status(200).json({
        received: true,
        ignored: true,
        reason: "No fax ID found",
      });
    }

    const faxResult = await db.query(
      `SELECT *
       FROM netphone_faxes
       WHERE telnyx_fax_id = $1
       LIMIT 1`,
      [faxId]
    );

    const fax = faxResult.rows[0];

    // The event may belong to the existing IRS/legacy fax flow.
    // If it is not in the new NetPhone fax table, leave it untouched.
    if (!fax) {
      return res.status(200).json({
        received: true,
        ignored: true,
        reason: "Fax does not belong to the new NetPhone fax service",
      });
    }

    let newStatus = null;
    let failureReason = null;

    switch (eventType) {
      case "fax.queued":
        newStatus = "queued";
        break;

      case "fax.media.processed":
        newStatus = "media_processed";
        break;

      case "fax.sending.started":
        newStatus = "sending";
        break;

      case "fax.delivered":
        newStatus = "delivered";
        break;

      case "fax.failed":
        newStatus = "failed";

        failureReason =
          payload?.failure_reason ||
          payload?.error ||
          payload?.result ||
          "Fax delivery failed";
        break;

      default:
        return res.status(200).json({
          received: true,
          ignored: true,
          event_type: eventType,
        });
    }

    const pages =
      payload?.page_count ??
      payload?.pages ??
      fax.pages ??
      null;

    const updateResult = await db.query(
      `UPDATE netphone_faxes
       SET
         status = $1,
         pages = $2,
         failure_reason = $3,
         updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [
        newStatus,
        pages,
        failureReason,
        fax.id,
      ]
    );

    const updatedFax = updateResult.rows[0];

    // User notification only for final delivery states.
    if (newStatus === "delivered") {
      try {
        await createNotification({
          userId: fax.user_id,
          faxId: fax.id,
          title: "Fax Delivered",
          message: `Your fax to ${fax.to_number} was delivered successfully.`,
          notificationType: "fax_delivered",
        });
      } catch (notificationError) {
        console.error(
          "Delivered Notification Error:",
          notificationError
        );
      }
    }

    if (newStatus === "failed") {
      try {
        await createNotification({
          userId: fax.user_id,
          faxId: fax.id,
          title: "Fax Failed",
          message: `Your fax to ${fax.to_number} could not be delivered.`,
          notificationType: "fax_failed",
        });
      } catch (notificationError) {
        console.error(
          "Failed Notification Error:",
          notificationError
        );
      }
    }

    return res.status(200).json({
      received: true,
      updated: true,
      fax: updatedFax,
    });
  } catch (error) {
    console.error(
      "Telnyx Fax Status Webhook Error:",
      error
    );

    // Acknowledge receipt so Telnyx does not repeatedly retry
    // because of an internal processing error.
    return res.status(200).json({
      received: true,
      processing_error: true,
    });
  }
}

module.exports = {
  telnyxStatusWebhook,
};