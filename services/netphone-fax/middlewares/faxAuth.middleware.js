const jwt = require("jsonwebtoken");

function faxAuthRequired(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    const token = header.startsWith("Bearer ")
      ? header.slice(7)
      : null;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const secret = process.env.JWT_ACCESS_SECRET;

    if (!secret) {
      console.error(
        "FAX AUTH ERROR: JWT_ACCESS_SECRET is missing"
      );

      return res.status(500).json({
        success: false,
        message: "Fax authentication configuration error",
      });
    }

    const decoded = jwt.verify(token, secret);

    if (!decoded.userId) {
      return res.status(401).json({
        success: false,
        message: "Invalid authentication token",
      });
    }

    req.user = {
      id: decoded.userId,
      phone: decoded.phone,
      role: decoded.role,
      status: decoded.status,
    };

    next();
  } catch (error) {
    console.error(
      "FAX JWT ERROR:",
      error.message
    );

    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
}

module.exports = {
  faxAuthRequired,
};