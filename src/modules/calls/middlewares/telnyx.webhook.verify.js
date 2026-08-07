"use strict";

/**
 * telnyx.webhook.verify.js
 * ---------------------------------------------------------
 * Telnyx Voice webhook signature verification middleware.
 *
 * Security model:
 * - Telnyx Ed25519 signature যাচাই করে।
 * - ৫ মিনিটের বেশি পুরোনো request replay হিসেবে ধরে।
 * - STRICT=false হলে verification failure log করে,
 *   কিন্তু বর্তমান calling flow বন্ধ করে না।
 * - STRICT=true হলে invalid webhook HTTP 403 পাবে।
 *
 * Required environment variables:
 * TELNYX_PUBLIC_KEY=...
 * TELNYX_WEBHOOK_VERIFY_STRICT=false
 */

const crypto = require("crypto");

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

/**
 * Environment boolean safely parse করে।
 */
function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }

  const normalized = String(value)
    .trim()
    .toLowerCase();

  if (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    return true;
  }

  if (
    normalized === "false" ||
    normalized === "0" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return false;
  }

  return fallback;
}

/**
 * Telnyx public key থেকে Node.js KeyObject তৈরি করে।
 *
 * Supported formats:
 * 1. PEM public key
 * 2. Base64-encoded raw 32-byte Ed25519 public key
 * 3. Base64-encoded SPKI DER public key
 */
function createTelnyxPublicKey(publicKeyValue) {
  const normalizedKey = String(
    publicKeyValue || ""
  ).trim();

  if (!normalizedKey) {
    throw new Error(
      "TELNYX_PUBLIC_KEY is not configured"
    );
  }

  /*
   * Portal থেকে PEM format এলে সরাসরি ব্যবহার হবে।
   */
  if (
    normalizedKey.includes(
      "BEGIN PUBLIC KEY"
    )
  ) {
    return crypto.createPublicKey(
      normalizedKey
    );
  }

  const decodedKey = Buffer.from(
    normalizedKey,
    "base64"
  );

  if (!decodedKey.length) {
    throw new Error(
      "TELNYX_PUBLIC_KEY is not valid Base64"
    );
  }

  /*
   * Raw Ed25519 public key সাধারণত 32 bytes।
   *
   * Node.js createPublicKey SPKI DER format চায়।
   * Ed25519 SPKI prefix:
   * 302a300506032b6570032100
   */
  if (decodedKey.length === 32) {
    const ed25519SpkiPrefix =
      Buffer.from(
        "302a300506032b6570032100",
        "hex"
      );

    const spkiKey = Buffer.concat([
      ed25519SpkiPrefix,
      decodedKey,
    ]);

    return crypto.createPublicKey({
      key: spkiKey,
      format: "der",
      type: "spki",
    });
  }

  /*
   * Key আগে থেকেই DER/SPKI হলে।
   */
  return crypto.createPublicKey({
    key: decodedKey,
    format: "der",
    type: "spki",
  });
}

/**
 * Unix timestamp seconds validate করে।
 */
function validateTimestamp(
  timestampHeader,
  toleranceSeconds =
    DEFAULT_TOLERANCE_SECONDS
) {
  const timestamp = Number(
    timestampHeader
  );

  if (
    !Number.isFinite(timestamp) ||
    timestamp <= 0
  ) {
    return {
      ok: false,
      reason:
        "invalid_telnyx_timestamp",
    };
  }

  const nowSeconds =
    Math.floor(Date.now() / 1000);

  const ageSeconds =
    Math.abs(nowSeconds - timestamp);

  if (ageSeconds > toleranceSeconds) {
    return {
      ok: false,
      reason:
        "telnyx_timestamp_outside_tolerance",
      ageSeconds,
    };
  }

  return {
    ok: true,
    timestamp,
    ageSeconds,
  };
}

/**
 * Telnyx webhook request signature যাচাই করে।
 */
function verifyTelnyxWebhook({
  rawBody,
  signature,
  timestamp,
  publicKey,
}) {
  if (!Buffer.isBuffer(rawBody)) {
    return {
      ok: false,
      reason:
        "telnyx_raw_body_missing",
    };
  }

  if (!signature) {
    return {
      ok: false,
      reason:
        "telnyx_signature_missing",
    };
  }

  const timestampResult =
    validateTimestamp(timestamp);

  if (!timestampResult.ok) {
    return timestampResult;
  }

  let signatureBuffer;

  try {
    signatureBuffer = Buffer.from(
      String(signature).trim(),
      "base64"
    );
  } catch {
    return {
      ok: false,
      reason:
        "invalid_telnyx_signature_encoding",
    };
  }

  if (!signatureBuffer.length) {
    return {
      ok: false,
      reason:
        "invalid_telnyx_signature_encoding",
    };
  }

  let keyObject;

  try {
    keyObject =
      createTelnyxPublicKey(
        publicKey
      );
  } catch (error) {
    return {
      ok: false,
      reason:
        "invalid_telnyx_public_key",
      message:
        error.message,
    };
  }

  /*
   * Telnyx signed message:
   *
   * timestamp|raw_json_payload
   */
  const signedPayload =
    Buffer.concat([
      Buffer.from(
        `${timestamp}|`,
        "utf8"
      ),
      rawBody,
    ]);

  let verified = false;

  try {
    /*
     * Ed25519-এর জন্য algorithm null দিতে হয়।
     */
    verified = crypto.verify(
      null,
      signedPayload,
      keyObject,
      signatureBuffer
    );
  } catch (error) {
    return {
      ok: false,
      reason:
        "telnyx_signature_verification_error",
      message:
        error.message,
    };
  }

  if (!verified) {
    return {
      ok: false,
      reason:
        "invalid_telnyx_signature",
    };
  }

  return {
    ok: true,
    timestamp:
      timestampResult.timestamp,
    ageSeconds:
      timestampResult.ageSeconds,
  };
}

/**
 * Express middleware.
 *
 * Optional mode:
 * TELNYX_WEBHOOK_VERIFY_STRICT=false
 *
 * Strict mode:
 * TELNYX_WEBHOOK_VERIFY_STRICT=true
 */
function verifyTelnyxWebhookMiddleware(
  req,
  res,
  next
) {
  const strictMode = parseBoolean(
    process.env
      .TELNYX_WEBHOOK_VERIFY_STRICT,
    false
  );

  const publicKey = String(
    process.env.TELNYX_PUBLIC_KEY || ""
  ).trim();

  const signature =
    req.get(
      "telnyx-signature-ed25519"
    ) || "";

  const timestamp =
    req.get("telnyx-timestamp") || "";

  const verification =
    verifyTelnyxWebhook({
      rawBody:
        req.rawBody,

      signature,
      timestamp,
      publicKey,
    });

  /*
   * Controller এবং logs চাইলে verification result
   * inspect করতে পারবে।
   */
  req.telnyxWebhookVerification =
    verification;

  if (verification.ok) {
    console.log(
      "✅ TELNYX WEBHOOK SIGNATURE VERIFIED",
      {
        eventType:
          req.body?.data?.event_type ||
          null,

        ageSeconds:
          verification.ageSeconds,

        strictMode,
      }
    );

    return next();
  }

  console.warn(
    "⚠️ TELNYX WEBHOOK SIGNATURE NOT VERIFIED",
    {
      eventType:
        req.body?.data?.event_type ||
        null,

      reason:
        verification.reason,

      message:
        verification.message ||
        null,

      strictMode,

      hasSignature:
        Boolean(signature),

      hasTimestamp:
        Boolean(timestamp),

      hasRawBody:
        Buffer.isBuffer(
          req.rawBody
        ),
    }
  );

  /*
   * Initial safe rollout:
   *
   * STRICT=false হলে current calling engine চলবে।
   * Logs দেখে verification নিশ্চিত হওয়ার পর
   * STRICT=true করা হবে।
   */
  if (!strictMode) {
    return next();
  }

  return res.status(403).json({
    ok: false,
    message:
      "Invalid Telnyx webhook signature",
    reason:
      verification.reason,
  });
}

module.exports = {
  verifyTelnyxWebhookMiddleware,
  verifyTelnyxWebhook,
  createTelnyxPublicKey,
  validateTimestamp,
};