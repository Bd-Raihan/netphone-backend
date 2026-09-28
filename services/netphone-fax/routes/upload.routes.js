const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");

const {
  faxAuthRequired,
} = require("../middlewares/faxAuth.middleware");

const {
  uploadFaxDocument,
  UPLOAD_DIR,
} = require("../controllers/upload.controller");

const router = express.Router();

const allowedMimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

const allowedExtensions = new Set([
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },

  filename: (req, file, cb) => {
    const extension = path
      .extname(file.originalname)
      .toLowerCase();

    const uniqueName =
      `${Date.now()}-${crypto.randomUUID()}${extension}`;

    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 1,
  },

  fileFilter: (req, file, cb) => {
    const extension = path
      .extname(file.originalname)
      .toLowerCase();

    if (
      !allowedMimeTypes.has(file.mimetype) ||
      !allowedExtensions.has(extension)
    ) {
      return cb(
        new Error(
          "Only PDF, JPG and PNG fax documents are allowed"
        )
      );
    }

    cb(null, true);
  },
});

router.post(
  "/upload",
  faxAuthRequired,
  upload.single("document"),
  uploadFaxDocument
);

module.exports = router;