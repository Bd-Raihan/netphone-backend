"use strict";

const crypto = require("crypto");

function createPublicKey(value) {
  const key = String(value || "").trim();

  if (!key) {
    throw new Error("TELNYX_PUBLIC_KEY missing");
  }

  if (key.includes("BEGIN PUBLIC KEY")) {
    return crypto.createPublicKey(key);
  }

  const decoded = Buffer.from(key, "base64");

  if (decoded.length === 32) {
    return crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        decoded
      ]),
      format: "der",
      type: "spki"
    });
  }

  return crypto.createPublicKey({
    key: decoded,
    format: "der",
    type: "spki"
  });
}

function verifyTelnyxSignature(req) {
  const signature = req.headers["telnyx-signature-ed25519"];
  const timestamp = req.headers["telnyx-timestamp"];

  if (
    typeof signature !== "string" ||
    typeof timestamp !== "string" ||
    !Buffer.isBuffer(req.rawBody)
  ) {
    return false;
  }

  if (!/^\d+$/.test(timestamp)) {
    return false;
  }

  const ts = Number(timestamp);

  if (
    !Number.isSafeInteger(ts) ||
    Math.abs(Date.now() / 1000 - ts) > 300
  ) {
    return false;
  }

  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) {
    return false;
  }

  try {
    const key = createPublicKey(
      process.env.TELNYX_PUBLIC_KEY
    );

    const signedPayload = Buffer.concat([
      Buffer.from(`${timestamp}|`, "utf8"),
      req.rawBody
    ]);

    return crypto.verify(
      null,
      signedPayload,
      key,
      Buffer.from(signature, "base64")
    );
  } catch {
    return false;
  }
}

module.exports = { verifyTelnyxSignature };