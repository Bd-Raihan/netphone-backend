const jwt = require("jsonwebtoken");
const db = require("../database/db");

async function faxAuthRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({success:false,message:"Authentication required"});
  let decoded;
  try {
    if (!process.env.JWT_ACCESS_SECRET) throw new Error("Missing authentication configuration");
    decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
  } catch (_) {
    return res.status(401).json({success:false,message:"Invalid or expired token"});
  }
  const userId = Number(decoded.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(401).json({success:false,message:"Invalid token"});
  try {
    // Read current permissions: a revoked admin/disabled account cannot reuse old JWT claims.
    const result = await db.query("SELECT id,phone_e164,role,status FROM users WHERE id=$1 LIMIT 1",[userId]);
    const user = result.rows[0];
    if (!user || user.status !== "active") return res.status(403).json({success:false,message:"Account unavailable"});
    req.user = {id:userId,phone:user.phone_e164,role:user.role,status:user.status};
    next();
  } catch (_) {
    return res.status(503).json({success:false,message:"Authentication temporarily unavailable"});
  }
}
function faxAdminRequired(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({success:false,message:"Admin access required"});
  next();
}
module.exports = {faxAuthRequired,faxAdminRequired};
