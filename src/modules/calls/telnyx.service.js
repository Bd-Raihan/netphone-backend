/**
 * telnyx.service.js
 * --------------------------------------------------
 * NetPhone Telnyx Voice API service
 *
 * Responsibilities:
 * 1. Send authenticated Telnyx API requests
 * 2. Start outbound PSTN calls
 * 3. Persist provider identifiers
 * 4. Send call-control commands
 * 5. Normalize provider errors
 */

const db = require("../../config/db");

const TELNYX_API_BASE_URL = "https://api.telnyx.com/v2";

/**
 * Read and validate the Telnyx API key.
 */
function getTelnyxApiKey() {
  const apiKey = String(
    process.env.TELNYX_API_KEY || ""
  ).trim();

  if (!apiKey) {
    throw new Error("TELNYX_API_KEY is missing");
  }

  return apiKey;
}

/**
 * Telnyx Voice API payload calls this connection_id.
 *
 * For Programmable Voice, its value is the active
 * Voice API Application ID.
 */
function getTelnyxConnectionId() {
  const connectionId = String(
    process.env.TELNYX_CONNECTION_ID || ""
  ).trim();

  if (!connectionId) {
    throw new Error(
      "TELNYX_CONNECTION_ID is missing"
    );
  }

  return connectionId;
}

/**
 * Read and validate the Telnyx caller number.
 */
function getTelnyxCallerNumber() {
  const callerNumber = String(
    process.env.TELNYX_PHONE_NUMBER || ""
  ).trim();

  if (!callerNumber) {
    throw new Error(
      "TELNYX_PHONE_NUMBER is missing"
    );
  }

  return callerNumber;
}

/**
 * Build the public webhook URL.
 */
function getTelnyxWebhookUrl() {
  const publicBaseUrl = String(
    process.env.PUBLIC_BASE_URL || ""
  )
    .trim()
    .replace(/\/+$/, "");

  if (!publicBaseUrl) {
    throw new Error(
      "PUBLIC_BASE_URL is missing"
    );
  }

  return `${publicBaseUrl}/api/calls/telnyx-events`;
}

/**
 * Perform a Telnyx API request.
 */
async function telnyxRequest({
  path,
  method = "GET",
  body,
  idempotencyKey,
}) {
  const headers = {
    Authorization: `Bearer ${getTelnyxApiKey()}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (idempotencyKey) {
    headers["Idempotency-Key"] =
      String(idempotencyKey);
  }

  const response = await fetch(
    `${TELNYX_API_BASE_URL}${path}`,
    {
      method,
      headers,
      body:
        body === undefined
          ? undefined
          : JSON.stringify(body),
    }
  );

  const responseText = await response.text();

  let result = {};

  if (responseText) {
    try {
      result = JSON.parse(responseText);
    } catch {
      result = {
        message: responseText,
      };
    }
  }

  if (!response.ok) {
    const providerError =
      result?.errors?.[0] || null;

    const errorMessage =
      providerError?.detail ||
      providerError?.title ||
      result?.message ||
      `Telnyx API request failed with status ${response.status}`;

    const error = new Error(errorMessage);

    error.statusCode = response.status;
    error.telnyxResponse = result;
    error.telnyxErrorCode =
      providerError?.code || null;

    throw error;
  }

  return result;
}

/**
 * Start a server-originated outbound Telnyx call.
 *
 * Important:
 * This creates the PSTN provider call.
 * Flutter two-way media still requires the Telnyx
 * client/WebRTC media integration.
 */
async function makeCall({
  to,
  sessionId,
}) {
  const destination = String(to || "").trim();
  const normalizedSessionId =
    Number(sessionId);

  if (!destination) {
    return {
      ok: false,
      error: "Destination number is required",
      details: null,
    };
  }

  if (
    !Number.isInteger(normalizedSessionId) ||
    normalizedSessionId <= 0
  ) {
    return {
      ok: false,
      error: "Valid sessionId is required",
      details: null,
    };
  }

  try {
    const clientState = Buffer.from(
      JSON.stringify({
        session_id: normalizedSessionId,
      }),
      "utf8"
    ).toString("base64");

    const result = await telnyxRequest({
      path: "/calls",
      method: "POST",
      idempotencyKey:
        `netphone-call-${normalizedSessionId}`,
      body: {
        connection_id:
          getTelnyxConnectionId(),

        to: destination,

        from:
          getTelnyxCallerNumber(),

        client_state:
          clientState,

        webhook_url:
          getTelnyxWebhookUrl(),

        webhook_url_method:
          "POST",

        answering_machine_detection:
          "disabled",
      },
    });

    const callData =
      result?.data || {};

    const callControlId =
      callData.call_control_id || null;

    const callLegId =
      callData.call_leg_id || null;

    const callSessionId =
      callData.call_session_id || null;

    if (!callControlId) {
      return {
        ok: false,
        error:
          "Telnyx did not return call_control_id",
        statusCode: 502,
        details: result,
      };
    }

    /*
     * Telnyx may send webhook events immediately after
     * accepting the call.
     *
     * Therefore, if this database update fails, we must
     * not falsely report the already-created provider
     * call as failed to Flutter.
     */
    let persistenceWarning = null;

    try {
      await db.query(
        `
          UPDATE call_sessions
          SET
            provider = 'telnyx',

            provider_call_id =
              $2::text,

            provider_status =
              $3::text,

            meta =
              COALESCE(
                meta,
                '{}'::jsonb
              ) ||
              jsonb_build_object(
                'telnyx_call_leg_id',
                COALESCE(
                  $4::text,
                  ''
                ),

                'telnyx_call_session_id',
                COALESCE(
                  $5::text,
                  ''
                )
              )

          WHERE id = $1::bigint
        `,
        [
          normalizedSessionId,
          callControlId,
          "initiated",
          callLegId,
          callSessionId,
        ]
      );
    } catch (databaseError) {
      persistenceWarning =
        databaseError.message;

      console.error(
        "❌ TELNYX CALL CREATED BUT SESSION UPDATE FAILED:",
        {
          sessionId:
            normalizedSessionId,

          callControlId,

          message:
            databaseError.message,

          stack:
            databaseError.stack,
        }
      );
    }

    return {
      ok: true,

      callControlId,

      callLegId,

      callSessionId,

      status: "initiated",

      persistenceWarning,

      raw: callData,
    };
  } catch (error) {
    console.error(
      "❌ TELNYX MAKE CALL ERROR:",
      error.telnyxResponse || error
    );

    return {
      ok: false,

      error:
        error.message ||
        "Telnyx call creation failed",

      statusCode:
        error.statusCode || null,

      errorCode:
        error.telnyxErrorCode || null,

      details:
        error.telnyxResponse || null,
    };
  }
}

/**
 * Hang up an active Telnyx call.
 */
async function hangupCall({
  callControlId,
}) {
  const normalizedCallControlId =
    String(callControlId || "").trim();

  if (!normalizedCallControlId) {
    return {
      ok: false,
      error:
        "callControlId is required",
      details: null,
    };
  }

  try {
    const result = await telnyxRequest({
      path:
        `/calls/${encodeURIComponent(
          normalizedCallControlId
        )}/actions/hangup`,

      method: "POST",

      body: {},
    });

    return {
      ok: true,
      data:
        result?.data || result,
    };
  } catch (error) {
    console.error(
      "❌ TELNYX HANGUP ERROR:",
      error.telnyxResponse || error
    );

    return {
      ok: false,

      error:
        error.message ||
        "Telnyx hangup failed",

      statusCode:
        error.statusCode || null,

      errorCode:
        error.telnyxErrorCode || null,

      details:
        error.telnyxResponse || null,
    };
  }
}

module.exports = {
  makeCall,
  hangupCall,
  telnyxRequest,
};