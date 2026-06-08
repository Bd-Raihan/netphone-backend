/**
 * notFound.js
 * -----------
 * কাজ: কোনো route না পেলে 404 response দেওয়া
 */

function notFound(req, res, next) {
  return res.status(404).json({
    success: false,
    message: "Route not found",
    path: req.originalUrl,
  });
}

module.exports = notFound;
