const axios = require("axios");
const path = require("path");
const fs = require("fs");
require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
});

const TELNYX_API_BASE = "https://api.telnyx.com/v2";

// Safety: this script only sends when explicitly executed.
// Nothing is sent merely by importing this file.

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
    throw new Error("Destination fax number must be in E.164 format.");
  }

  if (!from.startsWith("+")) {
    throw new Error("TELNYX_FAX_PHONE_NUMBER must be in E.164 format.");
  }

  if (!mediaUrl && !mediaName) {
    throw new Error("Either mediaUrl or mediaName is required.");
  }

  if (mediaUrl && mediaName) {
    throw new Error("Use mediaUrl OR mediaName, not both.");
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

  console.log("\n========== NETPHONE FAX ==========");
  console.log(`FROM : ${from}`);
  console.log(`TO   : ${to}`);
  console.log(
    `MEDIA: ${mediaName || mediaUrl}`
  );
  console.log(`CONNECTION ID: ${connectionId}`);
  console.log("==================================\n");

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

async function main() {
  try {
    const [, , to, media] = process.argv;

    if (!to || !media) {
      console.log(
        "Usage: node send-fax.js <TO_NUMBER> <MEDIA_URL_OR_MEDIA_NAME>"
      );
      process.exit(1);
    }

    const isUrl =
      media.startsWith("https://") ||
      media.startsWith("http://");

    const result = await sendFax({
      to,
      ...(isUrl
        ? { mediaUrl: media }
        : { mediaName: media }),
      clientState: `netphone-fax-${Date.now()}`,
    });

    console.log("Fax accepted by Telnyx.");
    console.log(JSON.stringify(result, null, 2));

    const faxId = result?.data?.id;

    if (faxId) {
      console.log(`\nFAX ID: ${faxId}`);
      console.log(
        "Next: verify final status before considering it delivered."
      );
    }
  } catch (error) {
    console.error("\nFAX SEND ERROR");

    if (error.response) {
      console.error(
        "HTTP:",
        error.response.status
      );

      console.error(
        JSON.stringify(error.response.data, null, 2)
      );
    } else {
      console.error(error.message);
    }

    process.exit(1);
  }
}

module.exports = {
  sendFax,
};

if (require.main === module) {
  main();
}