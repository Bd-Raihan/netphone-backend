const fs = require("fs");
const path = require("path");
const db = require("../database/db");
const {loadIncomingDocument} = require("../services/faxPlatform.service");

const UPLOAD_DIR = path.resolve(
  __dirname,
  "../storage/uploads"
);

function safeStoredFileName(fileName) {
  if (!fileName) {
    return null;
  }

  // Prevent ../ or directory traversal
  return path.basename(String(fileName));
}

async function getOwnedFax(faxId, userId) {
  const result = await db.query(
    `SELECT
       id,
       user_id,
       direction,
       file_name,
       file_url,
       status
     FROM netphone_faxes
     WHERE id = $1
       AND user_id = $2
     LIMIT 1`,
    [faxId, userId]
  );

  return result.rows[0] || null;
}

async function getDocument(req, res, download) {
  try {
    const userId = Number(req.user?.id);
    const faxId = Number(req.params.faxId);

    if (
      !Number.isInteger(userId) ||
      userId <= 0 ||
      !Number.isInteger(faxId) ||
      faxId <= 0
    ) {
      return res.status(404).json({
        success: false,
        message: "Fax document not found",
      });
    }

    const fax = await getOwnedFax(faxId, userId);

    // Deliberately return 404 instead of revealing
    // whether another user's fax exists.
    if (!fax) {
      return res.status(404).json({
        success: false,
        message: "Fax document not found",
      });
    }

    res.set({"Cache-Control":"no-store, private","X-Content-Type-Options":"nosniff"});
    if (fax.direction === "inbound") {
      const bytes = await loadIncomingDocument(userId, faxId);
      res.set({
        "Content-Type":"application/pdf",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="NetPhone_Fax_${faxId}.pdf"`,
      });
      return res.send(bytes);
    }

    const storedFileName =
      safeStoredFileName(fax.file_name);

    if (!storedFileName) {
      return res.status(404).json({
        success: false,
        message: "Fax document not found",
      });
    }

    const filePath = path.resolve(
      UPLOAD_DIR,
      storedFileName
    );

    // Extra path traversal protection
    if (
      path.dirname(filePath) !==
      path.resolve(UPLOAD_DIR)
    ) {
      return res.status(404).json({
        success: false,
        message: "Fax document not found",
      });
    }

    if (
      !fs.existsSync(filePath) ||
      !fs.statSync(filePath).isFile()
    ) {
      return res.status(404).json({
        success: false,
        message: "Fax document not found",
      });
    }

    if (download) {
      return res.download(
        filePath,
        storedFileName
      );
    }

    return res.sendFile(filePath);
  } catch (error) {
    console.error(
      "Fax Document Error:",
      error
    );

    return res.status(error.status || 500).json({
      success: false,
      message: error.status ? error.message : "Unable to access fax document",
    });
  }
}

async function viewFaxDocument(req, res) {
  return getDocument(req, res, false);
}

async function downloadFaxDocument(req, res) {
  return getDocument(req, res, true);
}

module.exports = {
  viewFaxDocument,
  downloadFaxDocument,
};