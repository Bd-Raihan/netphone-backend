const fs = require("fs");
const path = require("path");

const {
  validateMediaToken,
} = require("../services/mediaToken.service");

const UPLOAD_DIR = path.resolve(
  __dirname,
  "../storage/uploads"
);

async function serveTelnyxMedia(req, res) {
  try {
    const token = String(req.params.token || "").trim();

    if (!token) {
      return res.status(404).end();
    }

    const media = await validateMediaToken(token);

    if (!media || !media.file_name) {
      return res.status(404).end();
    }

    const safeFileName = path.basename(
      String(media.file_name)
    );

    const filePath = path.resolve(
      UPLOAD_DIR,
      safeFileName
    );

    if (
      path.dirname(filePath) !== path.resolve(UPLOAD_DIR)
    ) {
      return res.status(404).end();
    }

    if (
      !fs.existsSync(filePath) ||
      !fs.statSync(filePath).isFile()
    ) {
      return res.status(404).end();
    }

    res.setHeader(
      "Cache-Control",
      "private, no-store, max-age=0"
    );

    return res.sendFile(filePath);
  } catch (error) {
    console.error(
      "Telnyx Media Access Error:",
      error.message
    );

    return res.status(404).end();
  }
}

module.exports = {
  serveTelnyxMedia,
};