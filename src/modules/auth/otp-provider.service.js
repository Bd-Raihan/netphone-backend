/**
 * otp-provider.service.js
 * --------------------------------------------------
 * NetPhone OTP Provider Adapter
 *
 * এই file-এর দায়িত্ব:
 *
 * 1. Auth module-কে OTP provider থেকে আলাদা রাখা
 * 2. বর্তমানে Twilio Verify দিয়ে OTP পাঠানো ও যাচাই করা
 * 3. ভবিষ্যতে Telnyx Verify migration সহজ করা
 *
 * Current:
 * OTP_PROVIDER=twilio
 *
 * Future:
 * OTP_PROVIDER=telnyx
 *
 * গুরুত্বপূর্ণ:
 * Voice calling-এর সঙ্গে এই service-এর কোনো সম্পর্ক নেই।
 */

const TWILIO_VERIFY_BASE_URL =
  "https://verify.twilio.com/v2";

/* =========================================================
 * SECTION 1
 * Provider selection
 * ========================================================= */

/**
 * Current OTP provider।
 *
 * .env-এ OTP_PROVIDER না থাকলে সাময়িকভাবে Twilio ব্যবহার হবে।
 */
function getOtpProvider() {
  return String(
    process.env.OTP_PROVIDER || "twilio"
  )
    .trim()
    .toLowerCase();
}

/* =========================================================
 * SECTION 2
 * Twilio Verify configuration
 * ========================================================= */

function getTwilioConfig() {
  const accountSid =
    process.env.TWILIO_ACCOUNT_SID;

  const authToken =
    process.env.TWILIO_AUTH_TOKEN;

  const verifyServiceSid =
    process.env.TWILIO_VERIFY_SERVICE_SID ||
    process.env.TWILIO_SERVICE_SID;

  const missing = [];

  if (!accountSid) {
    missing.push("TWILIO_ACCOUNT_SID");
  }

  if (!authToken) {
    missing.push("TWILIO_AUTH_TOKEN");
  }

  if (!verifyServiceSid) {
    missing.push(
      "TWILIO_VERIFY_SERVICE_SID"
    );
  }

  if (missing.length > 0) {
    throw new Error(
      `Twilio Verify configuration missing: ${missing.join(
        ", "
      )}`
    );
  }

  return {
    accountSid,
    authToken,
    verifyServiceSid,
  };
}

/**
 * Twilio Verify API request helper।
 *
 * npm twilio package প্রয়োজন নেই।
 * Node.js built-in fetch ব্যবহার করা হচ্ছে।
 */
async function twilioVerifyRequest({
  path,
  form,
}) {
  const {
    accountSid,
    authToken,
  } = getTwilioConfig();

  const basicAuth = Buffer.from(
    `${accountSid}:${authToken}`,
    "utf8"
  ).toString("base64");

  const response = await fetch(
    `${TWILIO_VERIFY_BASE_URL}${path}`,
    {
      method: "POST",

      headers: {
        Authorization:
          `Basic ${basicAuth}`,

        "Content-Type":
          "application/x-www-form-urlencoded",

        Accept: "application/json",
      },

      body: new URLSearchParams(form)
        .toString(),
    }
  );

  const responseText =
    await response.text();

  let result = {};

  if (responseText) {
    try {
      result =
        JSON.parse(responseText);
    } catch {
      result = {
        message: responseText,
      };
    }
  }

  if (!response.ok) {
    const message =
      result?.message ||
      result?.detail ||
      `Twilio Verify request failed with status ${response.status}`;

    const error = new Error(message);

    error.statusCode =
      response.status;

    error.provider =
      "twilio";

    error.providerResponse =
      result;

    throw error;
  }

  return result;
}

/* =========================================================
 * SECTION 3
 * Twilio Verify implementation
 * ========================================================= */

/**
 * Twilio Verify দিয়ে SMS OTP পাঠায়।
 */
async function sendOtpWithTwilio({
  to,
}) {
  const {
    verifyServiceSid,
  } = getTwilioConfig();

  const result =
    await twilioVerifyRequest({
      path:
        `/Services/${encodeURIComponent(
          verifyServiceSid
        )}/Verifications`,

      form: {
        To: to,
        Channel: "sms",
      },
    });

  return {
    ok:
      result.status === "pending",

    provider:
      "twilio",

    status:
      result.status || null,

    verification_sid:
      result.sid || null,
  };
}

/**
 * Twilio Verify দিয়ে user-এর OTP code যাচাই করে।
 */
async function checkOtpWithTwilio({
  to,
  code,
}) {
  const {
    verifyServiceSid,
  } = getTwilioConfig();

  const result =
    await twilioVerifyRequest({
      path:
        `/Services/${encodeURIComponent(
          verifyServiceSid
        )}/VerificationCheck`,

      form: {
        To: to,
        Code: code,
      },
    });

  const approved =
    result.status === "approved" &&
    result.valid !== false;

  return {
    ok: approved,

    provider:
      "twilio",

    status:
      result.status || null,

    valid:
      approved,

    verification_sid:
      result.sid || null,
  };
}

/* =========================================================
 * SECTION 4
 * Future Telnyx OTP placeholders
 * ========================================================= */

/**
 * ভবিষ্যৎ Telnyx Verify migration এখানেই implement হবে।
 *
 * Auth controller বা Flutter পরিবর্তন করতে হবে না।
 */
async function sendOtpWithTelnyx() {
  const error = new Error(
    "Telnyx OTP provider is not configured yet"
  );

  error.statusCode = 503;
  error.code =
    "TELNYX_OTP_NOT_CONFIGURED";

  throw error;
}

async function checkOtpWithTelnyx() {
  const error = new Error(
    "Telnyx OTP provider is not configured yet"
  );

  error.statusCode = 503;
  error.code =
    "TELNYX_OTP_NOT_CONFIGURED";

  throw error;
}

/* =========================================================
 * SECTION 5
 * Public provider-neutral interface
 * ========================================================= */

/**
 * Auth controller এই generic function call করবে।
 */
async function sendOtpSms({
  to,
}) {
  const provider =
    getOtpProvider();

  if (provider === "twilio") {
    return sendOtpWithTwilio({
      to,
    });
  }

  if (provider === "telnyx") {
    return sendOtpWithTelnyx({
      to,
    });
  }

  throw new Error(
    `Unsupported OTP provider: ${provider}`
  );
}

/**
 * Auth controller এই generic function call করবে।
 */
async function checkOtpVerify({
  to,
  code,
}) {
  const provider =
    getOtpProvider();

  if (provider === "twilio") {
    return checkOtpWithTwilio({
      to,
      code,
    });
  }

  if (provider === "telnyx") {
    return checkOtpWithTelnyx({
      to,
      code,
    });
  }

  throw new Error(
    `Unsupported OTP provider: ${provider}`
  );
}

module.exports = {
  sendOtpSms,
  checkOtpVerify,
};