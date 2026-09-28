const db = require("../database/db");

const {
  sendFax,
} = require("../services/telnyxFax.service");

const {
  createMediaToken,
  revokeMediaTokens,
} = require("../services/mediaToken.service");

const {
  createNotification,
} = require("../notifications/notification.service");

/**
 * Create and send outbound fax securely.
 *
 * Security:
 * - user_id comes from verified JWT only.
 * - uploaded document must belong to the authenticated user.
 * - client cannot provide arbitrary media URL.
 * - Telnyx receives only a temporary media-token URL.
 */
async function createFax(req, res) {
  let faxRecord = null;
  let mediaTokenCreated = false;

  try {
    const userId = Number(req.user?.id);

    const {
      upload_id,
      to_number,
      sender_name,
      user_email,
      country_code,
    } = req.body;

    const uploadId = Number(upload_id);
    const toNumber = String(to_number || "").trim();

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
      !Number.isInteger(uploadId) ||
      uploadId <= 0 ||
      !toNumber
    ) {
      return res.status(400).json({
        success: false,
        message:
          "upload_id and to_number are required",
      });
    }

    if (!toNumber.startsWith("+")) {
      return res.status(400).json({
        success: false,
        message:
          "Destination fax number must be in E.164 format",
      });
    }

    // The upload must belong to the authenticated user
    // and must not already have been consumed.
    const uploadResult = await db.query(
      `SELECT
         id,
         user_id,
         stored_file_name,
         original_file_name,
         mime_type,
         file_size,
         is_used
       FROM netphone_fax_uploads
       WHERE id = $1
         AND user_id = $2
         AND is_used = FALSE
       LIMIT 1`,
      [
        uploadId,
        userId,
      ]
    );

    const upload = uploadResult.rows[0];

    // Do not reveal whether another user's upload exists.
    if (!upload) {
      return res.status(404).json({
        success: false,
        message: "Fax upload not found",
      });
    }

    const fromNumber = String(
      process.env.TELNYX_FAX_PHONE_NUMBER || ""
    ).trim();

    if (!fromNumber) {
      throw new Error(
        "TELNYX_FAX_PHONE_NUMBER is not configured"
      );
    }

    // Create fax record first.
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
       VALUES
       ($1,$2,'outbound',$3,$4,'queued',$5,NULL,$6,$7)
       RETURNING *`,
      [
        userId,
        sender_name
          ? String(sender_name).trim()
          : null,
        fromNumber,
        toNumber,
        upload.stored_file_name,
        user_email
          ? String(user_email).trim()
          : null,
        country_code
          ? String(country_code).trim()
          : null,
      ]
    );

    faxRecord = insertResult.rows[0];

    // Generate temporary secret media token.
    const {
      token,
      expiresAt,
    } = await createMediaToken(faxRecord.id);

    mediaTokenCreated = true;

    const publicBaseUrl = String(
      process.env.FAX_PUBLIC_BASE_URL || ""
    )
      .trim()
      .replace(/\/+$/, "");

    if (!publicBaseUrl) {
      throw new Error(
        "FAX_PUBLIC_BASE_URL is not configured"
      );
    }

    const temporaryMediaUrl =
      `${publicBaseUrl}/api/fax/media/` +
      encodeURIComponent(token);

    // Send real fax request to Telnyx.
    const telnyxResult = await sendFax({
      to: toNumber,
      mediaUrl: temporaryMediaUrl,
      clientState:
        `netphone-fax-${faxRecord.id}`,
    });

    const telnyxFaxId =
      telnyxResult?.data?.id || null;

    const telnyxStatus =
      telnyxResult?.data?.status || "queued";

    if (!telnyxFaxId) {
      throw new Error(
        "Telnyx accepted request but no fax ID was returned"
      );
    }

    // Save Telnyx ID and mark upload as consumed.
    await db.query("BEGIN");

    try {
      const updateFaxResult = await db.query(
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

      const uploadUpdate = await db.query(
        `UPDATE netphone_fax_uploads
         SET is_used = TRUE
         WHERE id = $1
           AND user_id = $2
           AND is_used = FALSE
         RETURNING id`,
        [
          uploadId,
          userId,
        ]
      );

      if (uploadUpdate.rowCount !== 1) {
        throw new Error(
          "Fax upload could not be finalized"
        );
      }

      await db.query("COMMIT");

      faxRecord = updateFaxResult.rows[0];
    } catch (transactionError) {
      await db.query("ROLLBACK");
      throw transactionError;
    }

    try {
      await createNotification({
        userId,
        faxId: faxRecord.id,
        title: "Fax Submitted",
        message:
          `Your fax to ${toNumber} has been submitted.`,
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
      fax: {
        id: faxRecord.id,
        direction: faxRecord.direction,
        from_number: faxRecord.from_number,
        to_number: faxRecord.to_number,
        status: faxRecord.status,
        file_name: upload.original_file_name,
        created_at: faxRecord.created_at,
        media_expires_at: expiresAt,
      },
    });
  } catch (error) {
    console.error(
      "Create/Send Fax Error:",
      error.response?.data ||
        error.message ||
        error
    );

    if (faxRecord?.id) {
      const failureReason =
        error.response?.data?.errors?.[0]?.detail ||
        error.response?.data?.errors?.[0]?.title ||
        error.message ||
        "Unable to send fax";

      try {
        await db.query(
          `UPDATE netphone_faxes
           SET
             status = 'failed',
             failure_reason = $1,
             updated_at = NOW()
           WHERE id = $2`,
          [
            String(failureReason).substring(
              0,
              2000
            ),
            faxRecord.id,
          ]
        );
      } catch (databaseError) {
        console.error(
          "Fax Failure Database Update Error:",
          databaseError
        );
      }

      if (mediaTokenCreated) {
        try {
          await revokeMediaTokens(
            faxRecord.id
          );
        } catch (revokeError) {
          console.error(
            "Media Token Revoke Error:",
            revokeError
          );
        }
      }

      try {
        await createNotification({
          userId: faxRecord.user_id,
          faxId: faxRecord.id,
          title: "Fax Submission Failed",
          message:
            "Your fax could not be submitted.",
          notificationType: "fax_failed",
        });
      } catch (notificationError) {
        console.error(
          "Fax Failure Notification Error:",
          notificationError
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

/**
 * Authenticated user's fax history.
 */
async function getFaxHistory(req, res) {
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

    const result = await db.query(
      `SELECT
         id,
         sender_name,
         direction,
         from_number,
         to_number,
         telnyx_fax_id,
         status,
         file_name,
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
    console.error(
      "Get Fax History Error:",
      error
    );

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