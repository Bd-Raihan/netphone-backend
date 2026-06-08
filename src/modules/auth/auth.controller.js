/**
 * auth.controller.js
 * কাজ:
 * - request OTP endpoint
 * - verify OTP endpoint -> JWT issue
 */

const jwt = require("jsonwebtoken");
const {
  findUserByPhone,
  createUserWithWallet,
  createOtp,
  verifyOtp,
} = require("./auth.service");
const { requestOtpSchema, verifyOtpSchema } = require("./auth.validation");

// ✅ helper: error response (dev/prod)
function sendServerError(res, err, where = "UNKNOWN") {
  // ✅ Terminal এ আসল error দেখাবে
  console.error(`❌ ERROR in ${where}:`, err);

  const isDev = (process.env.NODE_ENV || "development") !== "production";

  return res.status(500).json({
    ok: false,
    message: isDev ? err.message : "Server error",
    where: isDev ? where : undefined,
    stack: isDev ? err.stack : undefined,
  });
}

// ✅ OTP request
async function requestOtp(req, res) {
  try {
    console.log("✅ /auth/request-otp BODY =>", req.body);

    const parsed = requestOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, errors: parsed.error.issues });
    }

    const phone = parsed.data.phone_e164;
    const expiresMin = Number(process.env.OTP_EXPIRES_MIN || 5);

    // ✅ user ensure
    let user = await findUserByPhone(phone);
    if (!user) user = await createUserWithWallet(phone);

    // ✅ create OTP
    const otp = await createOtp(phone, expiresMin);

    // ⚠️ MVP: SMS integration না হওয়া পর্যন্ত otp.code response এ দেখাবো
    return res.json({
      ok: true,
      message: "OTP created",
      expires_at: otp.expires_at,
      dev_otp: otp.code,
      user: { id: user.id, phone: user.phone_e164 }, // dev help
    });
  } catch (err) {
    return sendServerError(res, err, "requestOtp");
  }
}

// ✅ OTP verify -> JWT issue
async function verifyOtpAndLogin(req, res) {
  try {
    console.log("✅ /auth/verify-otp BODY =>", req.body);

    const parsed = verifyOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, errors: parsed.error.issues });
    }

    const { phone_e164, code } = parsed.data;

    const result = await verifyOtp(phone_e164, code);
    if (!result.ok) {
      return res.status(401).json({ ok: false, reason: result.reason });
    }

    let user = await findUserByPhone(phone_e164);
    if (!user) user = await createUserWithWallet(phone_e164);

    if (user.status !== "active") {
      return res.status(403).json({ ok: false, message: "User blocked" });
    }

    // ✅ Secrets check (dev-friendly)
    if (!process.env.JWT_ACCESS_SECRET || !process.env.JWT_REFRESH_SECRET) {
      throw new Error("JWT secrets missing: JWT_ACCESS_SECRET / JWT_REFRESH_SECRET");
    }

    // ✅ access token
    const accessToken = jwt.sign(
      { userId: user.id, phone: user.phone_e164, role: user.role, status: user.status },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: process.env.JWT_ACCESS_EXPIRES || "20m" }
    );

    // ✅ refresh token (MVP)
    const refreshToken = jwt.sign(
      { userId: user.id, phone: user.phone_e164, role: user.role, status: user.status },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: process.env.JWT_REFRESH_EXPIRES || "30d" }
    );

    return res.json({
      ok: true,
      accessToken,
      refreshToken,
      user: { id: user.id, phone: user.phone_e164, role: user.role, status: user.status },
    });
  } catch (err) {
    return sendServerError(res, err, "verifyOtpAndLogin");
  }
}

module.exports = {
  requestOtp,
  verifyOtpAndLogin,
};
