const axios = require("axios");
const crypto = require("crypto");

const TELNYX_API_BASE = "https://api.telnyx.com/v2";

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

function normalizePhone(value) {
  return String(value || "").trim();
}

function getStatusToken(faxId) {
  return crypto
    .createHmac("sha256", requireEnv("TELNYX_FAX_API_KEY"))
    .update(`netphone-fax-status:${faxId}`)
    .digest("hex");
}

function verifyStatusToken(faxId, token) {
  if (!/^[1-9]\d*$/.test(String(faxId || "")) ||
      !/^[a-f0-9]{64}$/.test(String(token || ""))) {
    return false;
  }

  const expected = Buffer.from(getStatusToken(faxId), "hex");
  const supplied = Buffer.from(String(token), "hex");
  return crypto.timingSafeEqual(expected, supplied);
}

function getStatusWebhookUrl(clientState) {
  const match = /^netphone-fax-([1-9]\d*)$/.exec(String(clientState || ""));
  if (!match) return null;

  const baseUrl = requireEnv("FAX_PUBLIC_BASE_URL").replace(/\/+$/, "");
  const webhookUrl = new URL(`${baseUrl}/api/fax/telnyx-status`);
  if (webhookUrl.protocol !== "https:") {
    throw new Error("FAX_PUBLIC_BASE_URL must use HTTPS.");
  }

  webhookUrl.searchParams.set("fax_id", match[1]);
  webhookUrl.searchParams.set("token", getStatusToken(match[1]));
  return webhookUrl.toString();
}

function normalizeFaxStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  switch (status) {
    case "queued": return "queued";
    case "media.processed":
    case "media_processed": return "media_processed";
    case "originated": return "originated";
    case "sending.started":
    case "sending": return "sending";
    case "delivered": return "delivered";
    case "failed": return "failed";
    case "initiated": return "initiated";
    case "receiving": return "receiving";
    case "media.processing":
    case "media_processing": return "media_processing";
    case "received": return "received";
    default: return null;
  }
}

async function getFax(faxId) {
  const id = String(faxId || "").trim();
  if (!id || id.length > 128) {
    throw new Error("A valid Telnyx fax ID is required.");
  }

  const response = await axios.get(
    `${TELNYX_API_BASE}/faxes/${encodeURIComponent(id)}`,
    {
      headers: {
        Authorization: `Bearer ${requireEnv("TELNYX_FAX_API_KEY")}`,
        Accept: "application/json",
      },
      timeout: 7000,
    }
  );

  const fax = response.data?.data;
  if (!fax || String(fax.id) !== id) {
    throw new Error("Invalid fax status response from Telnyx.");
  }
  return fax;
}

async function sendFax({
  to,
  mediaUrl,
  mediaName,
  clientState,
}) {
  const apiKey = requireEnv("TELNYX_FAX_API_KEY");
  const connectionId = requireEnv("TELNYX_FAX_CONNECTION_ID");
  const from = normalizePhone(
    requireEnv("TELNYX_FAX_PHONE_NUMBER")
  );

  to = normalizePhone(to);

  if (!to.startsWith("+")) {
    throw new Error(
      "Destination fax number must be in E.164 format."
    );
  }

  if (!from.startsWith("+")) {
    throw new Error(
      "TELNYX_FAX_PHONE_NUMBER must be in E.164 format."
    );
  }

  if (!mediaUrl && !mediaName) {
    throw new Error(
      "Either mediaUrl or mediaName is required."
    );
  }

  if (mediaUrl && mediaName) {
    throw new Error(
      "Use mediaUrl OR mediaName, not both."
    );
  }

  const payload = {
    connection_id: connectionId,
    from,
    to,
    store_media: true,
  };

  // Override only this app's outbound callback. The Fax Application's
  // existing inbound/IRS webhook configuration remains unchanged.
  const webhookUrl = getStatusWebhookUrl(clientState);
  if (webhookUrl) payload.webhook_url = webhookUrl;

  if (mediaUrl) {
    payload.media_url = mediaUrl;
  }

  if (mediaName) {
    payload.media_name = mediaName;
  }

  if (clientState) {
    payload.client_state = Buffer
      .from(clientState)
      .toString("base64");
  }

  const response = await axios.post(
    `${TELNYX_API_BASE}/faxes`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 30000,
    }
  );

  return response.data;
}

module.exports = {
  sendFax,
  getFax,
  normalizeFaxStatus,
  verifyStatusToken,
};