const {
  rechargeRequestSchema,
  approveRechargeSchema,
  rejectRechargeSchema,
} = require("./crypto.validation");

const cryptoService = require("./crypto.service");

function isAdmin(req) {
  return req.user && req.user.role === "admin";
}

async function createRechargeRequest(req, res) {
  try {
    const parsed = rechargeRequestSchema.safeParse
      ? rechargeRequestSchema.safeParse(req.body)
      : null;

    const { error, value } = rechargeRequestSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({
        ok: false,
        message: "Invalid crypto recharge data",
        errors: error.details.map((e) => e.message),
      });
    }

    const request = await cryptoService.createRechargeRequest(req.user, value);

    return res.status(201).json({
      ok: true,
      message: "Crypto recharge request submitted successfully",
      request,
    });
  } catch (err) {
    console.error("Create crypto recharge error:", err);
    return res.status(500).json({
      ok: false,
      message: err.message || "Failed to create crypto recharge request",
    });
  }
}

async function getMyRechargeRequests(req, res) {
  try {
    const requests = await cryptoService.getMyRechargeRequests(req.user.id);

    return res.json({
      ok: true,
      requests,
    });
  } catch (err) {
    console.error("Get my crypto recharge error:", err);
    return res.status(500).json({
      ok: false,
      message: err.message || "Failed to load recharge requests",
    });
  }
}

async function getAdminRechargeRequests(req, res) {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({
        ok: false,
        message: "Admin access required",
      });
    }

    const status = req.query.status || "pending";
    const requests = await cryptoService.getAdminRechargeRequests(status);

    return res.json({
      ok: true,
      requests,
    });
  } catch (err) {
    console.error("Admin crypto recharge list error:", err);
    return res.status(500).json({
      ok: false,
      message: err.message || "Failed to load admin recharge requests",
    });
  }
}

async function approveRechargeRequest(req, res) {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({
        ok: false,
        message: "Admin access required",
      });
    }

    const { error, value } = approveRechargeSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({
        ok: false,
        message: "Invalid approve data",
        errors: error.details.map((e) => e.message),
      });
    }

    const result = await cryptoService.approveRechargeRequest(
      req.user,
      req.params.id,
      value.admin_note || ""
    );

    return res.json({
      ok: true,
      message: "Recharge request approved successfully",
      ...result,
    });
  } catch (err) {
    console.error("Approve crypto recharge error:", err);
    return res.status(400).json({
      ok: false,
      message: err.message || "Failed to approve recharge request",
    });
  }
}

async function rejectRechargeRequest(req, res) {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({
        ok: false,
        message: "Admin access required",
      });
    }

    const { error, value } = rejectRechargeSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({
        ok: false,
        message: "Invalid reject data",
        errors: error.details.map((e) => e.message),
      });
    }

    const request = await cryptoService.rejectRechargeRequest(
      req.user,
      req.params.id,
      value.admin_note
    );

    return res.json({
      ok: true,
      message: "Recharge request rejected successfully",
      request,
    });
  } catch (err) {
    console.error("Reject crypto recharge error:", err);
    return res.status(400).json({
      ok: false,
      message: err.message || "Failed to reject recharge request",
    });
  }
}

async function cryptoWebhook(req, res) {
  return res.json({
    ok: true,
    message: "Crypto webhook reserved for future auto payment gateway",
  });
}

async function getCryptoConfig(req, res) {
  try {
    const config = cryptoService.getCryptoConfig();

    if (!config.wallet_address) {
      return res.status(500).json({
        ok: false,
        message: "Crypto wallet address not configured",
      });
    }

    return res.json({
      ok: true,
      config,
    });
  } catch (err) {
    console.error("Crypto config error:", err);
    return res.status(500).json({
      ok: false,
      message: err.message || "Failed to load crypto config",
    });
  }
}



module.exports = {
  createRechargeRequest,
  getMyRechargeRequests,
  getAdminRechargeRequests,
  approveRechargeRequest,
  rejectRechargeRequest,
  cryptoWebhook,
  getCryptoConfig,
};