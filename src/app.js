/**
 * app.js
 **/
const express = require("express"); // Express framework
const cors = require("cors"); // CORS middleware
const helmet = require("helmet"); // Security headers middleware
const rateLimit = require("express-rate-limit"); // Rate limiting middleware
const morgan = require("morgan"); // HTTP request logger middleware
const notFound = require("./middlewares/notFound"); // 404 handler middleware
const errorHandler = require("./middlewares/errorHandler"); // Global error handler middleware
const countryRoutes = require("./modules/countries/countries.routes"); // Country related routes
const authRoutes = require("./modules/auth/auth.routes"); // Authentication related routes
const healthRoutes = require("./modules/health/health.routes"); // Health check routes
const walletRoutes = require("./modules/wallet/wallet.routes"); // Wallet related routes
const callsRoutes = require("./modules/calls/calls.routes"); // Call related routes
const paymentRoutes = require("./modules/payment/payment.routes");
const cryptoRoutes = require("./modules/crypto/crypto.routes");
const adminCryptoRoutes = require("./modules/admin/admin.crypto.routes"); // Admin crypto management routes
const adminProfitRoutes = require("./modules/admin-profit/admin.profit.routes");
const appPagesRoutes = require("./modules/app-pages/app.pages.routes");
// Express app তৈরি
const app = express();
// Global Middlewares
// JSON body পড়ার জন্য
app.use(express.json());

app.use(express.urlencoded({ extended: false }));
/// SECURITY HEADERS
/// Hacker থেকে basic protection দিবে
app.use(helmet());
/// CORS
/// Flutter app API access করতে পারবে
app.use(cors());
/// RATE LIMIT
/// spam request block করবে
const limiter = rateLimit({
  windowMs: 60 * 1000,  max: 100,
  message: { ok: false, message: "Too many requests. Try again later.", },
});
app.use(limiter);
// ✅ Debug: request এ কি body আসছে দেখার জন্য
app.use((req, res, next) => {
  //console.log("REQ", req.method, req.url, "BODY =>", req.body);
  next();
});
// Request log দেখানোর জন্য (development এ কাজে আসে)
app.use(morgan("dev"));
// Routes (Module-wise)
app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/countries", countryRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/calls", callsRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/crypto", cryptoRoutes);
app.use("/api/admin/crypto", adminCryptoRoutes);
app.use("/api/admin/profit", adminProfitRoutes);
app.use("/api/app-pages", appPagesRoutes);  
// 404 handler (সব route fail হলে)
app.use(notFound);
// final error handler
app.use(errorHandler);
// Export app
module.exports = app;
