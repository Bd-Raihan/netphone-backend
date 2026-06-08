/**
 * requireAdmin.js
 * কাজ: Admin route গুলো নিরাপদ করা
 * ব্যবহার: Header এ x-admin-key পাঠাতে হবে
 */

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];

  // ✅ যদি key না পাঠায়
  if (!key) {
    return res.status(401).json({
      ok: false,
      message: "Admin key missing (x-admin-key header required)",
    });
  }

  // ✅ ENV এর সাথে মিলিয়ে দেখা
  if (key !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({
      ok: false,
      message: "Invalid admin key",
    });
  }

  next();
}


module.exports = requireAdmin;
