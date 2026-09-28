const express = require("express");
const cors = require("cors");
const multer = require("multer");

require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.FAX_PORT || 8787;

// Fax routes
const faxRoutes = require("./routes/fax.routes");
app.use("/api/fax", faxRoutes);

// Fax notification routes
const notificationRoutes =
  require("./routes/notification.routes");

app.use(
  "/api/fax/notifications",
  notificationRoutes
);

// Telnyx outbound fax status routes
const telnyxWebhookRoutes =
  require("./routes/telnyxWebhook.routes");

app.use(
  "/api/fax",
  telnyxWebhookRoutes
);

// Fax document upload routes
const uploadRoutes =
  require("./routes/upload.routes");

app.use(
  "/api/fax",
  uploadRoutes
);

// Secure authenticated View / Download
const documentRoutes =
  require("./routes/document.routes");

app.use(
  "/api/fax",
  documentRoutes
);

// Temporary Telnyx media access
const mediaRoutes =
  require("./routes/media.routes");

app.use(
  "/api/fax",
  mediaRoutes
);

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    service: "NetPhone Fax Service",
    status: "running",
  });
});

// Upload / application error handling
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        message:
          "Fax document must not exceed 20 MB",
      });
    }

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }

  if (
    error &&
    error.message ===
      "Only PDF, JPG and PNG fax documents are allowed"
  ) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }

  if (error) {
    console.error(
      "NetPhone Fax Service Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Internal fax service error",
    });
  }

  next();
});

app.listen(PORT, () => {
  console.log(
    `NetPhone Fax Service running on port ${PORT}`
  );
});