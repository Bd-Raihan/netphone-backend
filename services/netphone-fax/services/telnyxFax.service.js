const axios = require("axios");

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
};