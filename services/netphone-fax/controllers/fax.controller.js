const db = require("../database/db");

const {
  sendFax,
} = require("../services/telnyxFax.service");

const {
  createNotification,
} = require("../notifications/notification.service");

/**
 * Create and send outbound fax
 */
async function createFax(req, res) {
  let faxRecord = null;

  try {
    const {
      user_id,
      sender_name,
      from_number,
      to_number,
      user_email,
      country_code,
      file_name,
      file_url,
    } = req.body;

    if (!user_id || !to_number || !file_url) {
      return res.status(400).json({
        success: false,
        message: "user_id, to_number and file_url are required",
      });
    }

    // Step 1: Create local fax record first
    const insertResult = await db.query(
      `INSERT INTO netphone_faxes
       (
         user_id,
         sender_name,
         direction,
         from_number,
         to_number,
         status,
         file_name,
         file_url,
         user_email,
         country_code
       )
       VALUES ($1,$2,'outbound',$3,$4,'queued',$5,$6,$7,$8)
       RETURNING *`,
      [
        user_id,
        sender_name || null,
        from_number || null,
        to_number,
        file_name || null,
        file_url,
        user_email || null,
        country_code || null,
      ]
    );

    faxRecord = insertResult.rows[0];

    // Step 2: Send fax through Telnyx
    const telnyxResult = await sendFax({
      to: to_number,
      mediaUrl: file_url,
      clientState: `netphone-fax-${faxRecord.id}`,
    });

    const telnyxFaxId = telnyxResult?.data?.id || null;
    const telnyxStatus =
      telnyxResult?.data?.status || "queued";

    if (!telnyxFaxId) {
      throw new Error(
        "Telnyx accepted request but no fax ID was returned."
      );
    }

    // Step 3: Save Telnyx fax ID and current status
    const updateResult = await db.query(
      `UPDATE netphone_faxes
       SET
         telnyx_fax_id = $1,
         status = $2,
         updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [
        telnyxFaxId,
        telnyxStatus,
        faxRecord.id,
      ]
    );

    const updatedFax = updateResult.rows[0];

    // Step 4: Create user notification
    try {
      await createNotification({
        userId: user_id,
        faxId: faxRecord.id,
        title: "Fax Submitted",
        message: `Your fax to ${to_number} has been submitted.`,
        notificationType: "fax_submitted",
      });
    } catch (notificationError) {
      console.error(
        "Fax Notification Error:",
        notificationError
      );
    }

    return res.status(201).json({
      success: true,
      message: "Fax submitted to Telnyx",
      fax: updatedFax,
    });
  } catch (error) {
    console.error(
      "Create/Send Fax Error:",
      error.response?.data || error.message || error
    );

    // If local fax record exists, save failure information
    if (faxRecord?.id) {
      try {
        const failureReason =
          error.response?.data?.errors?.[0]?.detail ||
          error.response?.data?.errors?.[0]?.title ||
          error.message ||
          "Unable to send fax";

        await db.query(
          `UPDATE netphone_faxes
           SET
             status = 'failed',
             failure_reason = $1,
             updated_at = NOW()
           WHERE id = $2`,
          [
            String(failureReason).substring(0, 2000),
            faxRecord.id,
          ]
        );

        try {
          await createNotification({
            userId: faxRecord.user_id,
            faxId: faxRecord.id,
            title: "Fax Submission Failed",
            message: "Your fax could not be submitted.",
            notificationType: "fax_failed",
          });
        } catch (notificationError) {
          console.error(
            "Fax Failure Notification Error:",
            notificationError
          );
        }
      } catch (databaseError) {
        console.error(
          "Fax Failure Database Update Error:",
          databaseError
        );
      }
    }

    return res.status(500).json({
      success: false,
      message: "Unable to send fax",
      fax_id: faxRecord?.id || null,
    });
  }
}

// User Fax History
async function getFaxHistory(req, res) {
  try {
    const userId = req.params.userId;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const result = await db.query(
      `SELECT
         id,
         user_id,
         sender_name,
         direction,
         from_number,
         to_number,
         telnyx_fax_id,
         status,
         file_name,
         file_url,
         pages,
         user_email,
         country_code,
         failure_reason,
         created_at,
         updated_at
       FROM netphone_faxes
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    return res.status(200).json({
      success: true,
      count: result.rows.length,
      faxes: result.rows,
    });
  } catch (error) {
    console.error("Get Fax History Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to get fax history",
    });
  }
}

module.exports = {
  createFax,
  getFaxHistory,
};