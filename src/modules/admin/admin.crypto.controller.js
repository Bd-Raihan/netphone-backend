const adminCryptoService = require("./admin.crypto.service");

async function getPendingRecharges(req, res) {
  try {
    const data = await adminCryptoService.getPendingRecharges();

    return res.json({
      ok: true,
      data,
    });
  } catch (err) {
    console.error("Admin pending crypto error:", err);
    return res.status(500).json({
      ok: false,
      message: err.message || "Failed to load pending recharges",
    });
  }
}

async function approveRecharge(req, res) {
  try {
    const rechargeId = Number(req.params.id);

    if (!rechargeId) {
      return res.status(400).json({
        ok: false,
        message: "Invalid recharge id",
      });
    }

    const result = await adminCryptoService.approveRecharge({
      rechargeId,
      adminUserId: req.user.id,
    });

    return res.json({
      ok: true,
      message: "Recharge approved successfully",
      data: result,
    });
  } catch (err) {
    console.error("Admin approve crypto error:", err);
    return res.status(400).json({
      ok: false,
      message: err.message || "Failed to approve recharge",
    });
  }
}

async function rejectRecharge(req, res) {
  try {
    const rechargeId = Number(req.params.id);
    const adminNote = req.body?.admin_note;

    if (!rechargeId) {
      return res.status(400).json({
        ok: false,
        message: "Invalid recharge id",
      });
    }

    const result = await adminCryptoService.rejectRecharge({
      rechargeId,
      adminUserId: req.user.id,
      adminNote,
    });

    return res.json({
      ok: true,
      message: "Recharge rejected successfully",
      data: result,
    });
  } catch (err) {
    console.error("Admin reject crypto error:", err);
    return res.status(400).json({
      ok: false,
      message: err.message || "Failed to reject recharge",
    });
  }
}

module.exports = {
  getPendingRecharges,
  approveRecharge,
  rejectRecharge,
};