const db = require("../../config/db");

// ✅ Basic API health
function healthCheck(req, res) {
  return res.status(200).json({
    ok: true,
    status: "API is running",
    time: new Date().toISOString(),
  });
}

// ✅ DB connection test
async function dbHealth(req, res) {
  try {
    const result = await db.query("SELECT NOW() as now");
    return res.status(200).json({
      ok: true,
      db: "connected",
      time: result.rows[0].now,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      db: "not_connected",
      error: err.message,
    });
  }
}

module.exports = {
  healthCheck,
  dbHealth,
};
