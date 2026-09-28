const path = require("path");
const fs = require("fs");
const db = require("../database/db");

const UPLOAD_DIR = path.resolve(
  __dirname,
  "../storage/uploads"
);

fs.mkdirSync(UPLOAD_DIR, {
  recursive: true,
});

async function uploadFaxDocument(req, res) {
  try {
    const userId = Number(req.user?.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      if (req.file?.path) {
        fs.unlink(req.file.path, () => {});
      }

      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Fax document is required",
      });
    }

    try {
      const result = await db.query(
        `INSERT INTO netphone_fax_uploads
         (
           user_id,
           stored_file_name,
           original_file_name,
           mime_type,
           file_size
         )
         VALUES ($1, $2, $3, $4, $5)
         RETURNING
           id,
           original_file_name,
           mime_type,
           file_size,
           created_at`,
        [
          userId,
          req.file.filename,
          req.file.originalname,
          req.file.mimetype,
          req.file.size,
        ]
      );

      const upload = result.rows[0];

      return res.status(201).json({
        success: true,
        message: "Fax document uploaded",
        upload: {
          upload_id: upload.id,
          original_name: upload.original_file_name,
          mime_type: upload.mime_type,
          size: upload.file_size,
          created_at: upload.created_at,
        },
      });
    } catch (databaseError) {
      // Do not leave an orphan file if DB insert fails.
      if (req.file?.path) {
        fs.unlink(req.file.path, () => {});
      }

      throw databaseError;
    }
  } catch (error) {
    console.error(
      "Fax Upload Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Unable to upload fax document",
    });
  }
}

module.exports = {
  uploadFaxDocument,
  UPLOAD_DIR,
};