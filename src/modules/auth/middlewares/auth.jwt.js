/**
 * auth.jwt.js
 * কাজ:
 * - JWT verify middleware
 */

const jwt = require("jsonwebtoken");

function authRequired(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    const token = header.startsWith("Bearer ")
      ? header.slice(7)
      : null;

    if (!token) {
      return res.status(401).json({
        ok: false,
        message: "Missing token",
      });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_ACCESS_SECRET
    );

    // ✅ VERY IMPORTANT FIX
    req.user = {
      id: decoded.userId,
      phone: decoded.phone,
      role: decoded.role,
      status: decoded.status,
    };

    next();
  } catch (err) {
    console.error("JWT ERROR:", err);

    return res.status(401).json({
      ok: false,
      message: "Invalid token",
    });
  }
}

function requireAdmin(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized",
      });
    }

    if (req.user.role !== "admin") {
      return res.status(403).json({
        ok: false,
        message: "Admin only",
      });
    }

    next();
  } catch (e) {
    console.error("ADMIN AUTH ERROR:", e);

    return res.status(500).json({
      ok: false,
      message: "Admin check failed",
    });
  }
}

module.exports = {
  authRequired,requireAdmin,
};