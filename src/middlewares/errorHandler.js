/**
 * errorHandler.js
 * --------------
 * কাজ: সব error এক জায়গায় handle করা (DEV এ আসল error দেখানো)
 */

function errorHandler(err, req, res, next) {
  console.error("❌ ERROR:", err); // ✅ টার্মিনালে পুরো error দেখাবে

  const isDev = (process.env.NODE_ENV || "development") !== "production";

  return res.status(err.statusCode || 500).json({
    success: false,
    message: isDev ? (err.message || "Server error") : "Server error",
    // ✅ DEV এ stack দিলে ডিবাগ সহজ হয়
    ...(isDev ? { stack: err.stack } : {}),
  });
}

module.exports = errorHandler;
