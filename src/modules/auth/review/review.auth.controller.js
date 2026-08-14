/**
 * review.auth.controller.js
 *
 * Google Play review-only login.
 * This does NOT change the normal Telnyx OTP flow.
 */

const jwt = require("jsonwebtoken");

const {
  findUserByPhone,
  createUserWithWallet,
  markUserVerifiedLogin,
} = require("../auth.service");

// Dedicated Google Play review credentials requested by the app owner.
const REVIEW_USERNAME = "google reviwe";
const REVIEW_PASSWORD = "adfr2412";

// A dedicated non-admin review user identity for the existing users/wallet system.
const REVIEW_PHONE_E164 = "+12025550199";

async function reviewLogin(req, res) {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (username !== REVIEW_USERNAME || password !== REVIEW_PASSWORD) {
      return res.status(401).json({
        ok: false,
        message: "Invalid review username or password",
      });
    }

    let user = await findUserByPhone(REVIEW_PHONE_E164);

    if (!user) {
      user = await createUserWithWallet(REVIEW_PHONE_E164);
    }

    if (user.status !== "active") {
      return res.status(403).json({
        ok: false,
        message: "Review user is blocked",
      });
    }

    user = await markUserVerifiedLogin(user.id);

    if (!process.env.JWT_ACCESS_SECRET || !process.env.JWT_REFRESH_SECRET) {
      throw new Error(
        "JWT secrets missing: JWT_ACCESS_SECRET / JWT_REFRESH_SECRET"
      );
    }

    // Force review access to be a normal user, never an admin.
    const reviewRole = "user";

    const accessToken = jwt.sign(
      {
        userId: user.id,
        phone: user.phone_e164,
        role: reviewRole,
        status: user.status,
      },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: process.env.JWT_ACCESS_EXPIRES || "20m" }
    );

    const refreshToken = jwt.sign(
      {
        userId: user.id,
        phone: user.phone_e164,
        role: reviewRole,
        status: user.status,
      },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: process.env.JWT_REFRESH_EXPIRES || "30d" }
    );

    return res.json({
      ok: true,
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        phone: user.phone_e164,
        role: reviewRole,
        status: user.status,
      },
    });
  } catch (err) {
    console.error("REVIEW LOGIN ERROR:", err);

    return res.status(500).json({
      ok: false,
      message:
        (process.env.NODE_ENV || "development") !== "production"
          ? err.message
          : "Server error",
    });
  }
}

module.exports = {
  reviewLogin,
};
