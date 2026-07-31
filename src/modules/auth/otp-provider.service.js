/**
 * otp-provider.service.js
 * --------------------------------------------------
 * NetPhone Telnyx Verify OTP Provider
 *
 * দায়িত্ব:
 * 1. Telnyx Verify দিয়ে SMS OTP পাঠানো
 * 2. Telnyx Verify দিয়ে OTP যাচাই করা
 * 3. Auth controller-কে provider-specific code থেকে আলাদা রাখা
 *
 * Voice calling-এর সঙ্গে এই service-এর কোনো সম্পর্ক নেই।
 */

const TELNYX_API_BASE_URL =
  "https://api.telnyx.com/v2";

/**
 * প্রয়োজনীয় Telnyx Verify configuration যাচাই করে।
 */
function getTelnyxVerifyConfig() {
  const apiKey = String(
    process.env.TELNYX_API_KEY || ""
  ).trim();

  const verifyProfileId = String(
    process.env.TELNYX_VERIFY_PROFILE_ID || ""
  ).trim();

  const missing = [];

  if (!apiKey) {
    missing.push("TELNYX_API_KEY");
  }

  if (!verifyProfileId) {
    missing.push(
      "TELNYX_VERIFY_PROFILE_ID"
    );
  }

  if (missing.length > 0) {
    const error = new Error(
      `Telnyx Verify configuration missing: ${missing.join(
        ", "
      )}`
    );

    error.statusCode = 500;
    error.code =
      "TELNYX_VERIFY_CONFIG_MISSING";
    error.provider = "telnyx";

    throw error;
  }

  return {
    apiKey,
    verifyProfileId,
  };
}

/**
 * E.164 phone number basic validation।
 */
function validatePhoneE164(phone) {
  const normalizedPhone =
    String(phone || "").trim();

  if (
    !/^\+\d{7,19}$/.test(
      normalizedPhone
    )
  ) {
    const error = new Error(
      "Phone number must be in E.164 format"
    );

    error.statusCode = 400;
    error.code =
      "INVALID_PHONE_E164";
    error.provider = "telnyx";

    throw error;
  }

  return normalizedPhone;
}

/**
 * Telnyx API request helper।
 *
 * কোনো নতুন npm package লাগবে না।
 * Node.js built-in fetch ব্যবহার করা হচ্ছে।
 */
async function telnyxVerifyRequest({
  path,
  body,
}) {
  const { apiKey } =
    getTelnyxVerifyConfig();

  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    15000
  );

  try {
    const response = await fetch(
      `${TELNYX_API_BASE_URL}${path}`,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${apiKey}`,

          "Content-Type":
            "application/json",

          Accept:
            "application/json",
        },

        body: JSON.stringify(body),

        signal: controller.signal,
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
      const firstError =
        Array.isArray(result?.errors)
          ? result.errors[0]
          : null;

      const message =
        firstError?.detail ||
        firstError?.title ||
        result?.detail ||
        result?.message ||
        `Telnyx Verify request failed with status ${response.status}`;

      const error =
        new Error(message);

      error.statusCode =
        response.status;

      error.code =
        firstError?.code ||
        result?.code ||
        "TELNYX_VERIFY_REQUEST_FAILED";

      error.provider =
        "telnyx";

      error.providerResponse =
        result;

      throw error;
    }

    return result;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError =
        new Error(
          "Telnyx Verify request timed out"
        );

      timeoutError.statusCode = 504;
      timeoutError.code =
        "TELNYX_VERIFY_TIMEOUT";
      timeoutError.provider =
        "telnyx";

      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Telnyx Verify দিয়ে SMS OTP পাঠায়।
 */
async function sendOtpWithTelnyx({
  to,
}) {
  const phoneNumber =
    validatePhoneE164(to);

  const {
    verifyProfileId,
  } = getTelnyxVerifyConfig();

  const result =
    await telnyxVerifyRequest({
      path:
        "/verifications/sms",

      body: {
        phone_number:
          phoneNumber,

        verify_profile_id:
          verifyProfileId,
      },
    });

  const data =
    result?.data || {};

  const pending =
    data.status === "pending";

  return {
    ok: pending,

    provider:
      "telnyx",

    status:
      data.status || null,

    verification_id:
      data.id || null,

    phone_number:
      data.phone_number ||
      phoneNumber,

    timeout_secs:
      Number(
        data.timeout_secs || 0
      ),
  };
}

/**
 * Telnyx Verify দিয়ে OTP code যাচাই করে।
 */
async function checkOtpWithTelnyx({
  to,
  code,
}) {
  const phoneNumber =
    validatePhoneE164(to);

  const normalizedCode =
    String(code || "").trim();

  if (
    !/^\d{4,10}$/.test(
      normalizedCode
    )
  ) {
    return {
      ok: false,
      provider: "telnyx",
      status: "rejected",
      valid: false,
      reason:
        "invalid_code_format",
    };
  }

  const {
    verifyProfileId,
  } = getTelnyxVerifyConfig();

  const encodedPhone =
    encodeURIComponent(
      phoneNumber
    );

  const result =
    await telnyxVerifyRequest({
      path:
        `/verifications/by_phone_number/${encodedPhone}/actions/verify`,

      body: {
        code:
          normalizedCode,

        verify_profile_id:
          verifyProfileId,
      },
    });

  const data =
    result?.data || {};

  const responseCode =
    String(
      data.response_code || ""
    )
      .trim()
      .toLowerCase();

  const accepted =
    responseCode === "accepted";

  return {
    ok: accepted,

    provider:
      "telnyx",

    status:
      responseCode || null,

    valid:
      accepted,

    reason:
      accepted
        ? null
        : responseCode ||
          "invalid_or_expired",

    phone_number:
      data.phone_number ||
      phoneNumber,
  };
}

/**
 * Provider-neutral public interface।
 *
 * auth.controller.js এই functions-ই ব্যবহার করবে।
 */
async function sendOtpSms({
  to,
}) {
  return sendOtpWithTelnyx({
    to,
  });
}

async function checkOtpVerify({
  to,
  code,
}) {
  return checkOtpWithTelnyx({
    to,
    code,
  });
}

module.exports = {
  sendOtpSms,
  checkOtpVerify,
};