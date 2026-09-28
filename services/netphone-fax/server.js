const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.FAX_PORT || 8787;

// Fax routes
const faxRoutes = require("./routes/fax.routes");
app.use("/api/fax", faxRoutes);

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    service: "NetPhone Fax Service",
    status: "running",
  });
});

app.listen(PORT, () => {
  console.log(`NetPhone Fax Service running on port ${PORT}`);
});