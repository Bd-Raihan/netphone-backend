/**
 * telnyx.service.js
 * --------------------------------------------------
 * NetPhone Telnyx Voice API service
 *
 * দায়িত্ব:
 * 1. Telnyx API request পাঠানো
 * 2. Outbound call তৈরি করা
 * 3. Call command পাঠানো
 * 4. Telnyx API response normalize করা
 */

const db = require("../../config/db");

const TELNYX_API_BASE_URL = "https://api.telnyx.com/v2";

function getTelnyxApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;

  if (!apiKey) {
    throw new Error("TELNYX_API_KEY is missing");
  }

  return apiKey;
}

function getTelnyxConnectionId() {
  const connectionId = process.env.TELNYX_CONNECTION_ID;

  if (!connectionId) {
    throw new Error("TELNYX_CONNECTION_ID is missing");
  }

  return connectionId;
}

function getTelnyxCallerNumber() {
  const callerNumber = process.env.TELNYX_PHONE_NUMBER;

  if (!callerNumber) {
    throw new Error("TELNYX_PHONE_NUMBER is missing");
  }

  return callerNumber;
}

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
    headers["Idempotency-Key"] = idempotencyKey;
  }

  const response = await fetch(`${TELNYX_API_BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

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
    const errorMessage =
      result?.errors?.[0]?.detail ||
      result?.errors?.[0]?.title ||
      result?.message ||
      `Telnyx API request failed with status ${response.status}`;

    const error = new Error(errorMessage);
    error.statusCode = response.status;
    error.telnyxResponse = result;

    throw error;
  }

  return result;
}

/**
 * Server-originated outbound call।
 *
 * গুরুত্বপূর্ণ:
 * Flutter app থেকে live two-way audio করার জন্য পরে
 * Telnyx Android WebRTC SDK ব্যবহার করা হবে।
 */
async function makeCall({ to, sessionId }) {
  try {
    const clientState = Buffer.from(
      JSON.stringify({
        session_id: sessionId,
      }),
      "utf8"
    ).toString("base64");

    const result = await telnyxRequest({
      path: "/calls",
      method: "POST",
      idempotencyKey: `netphone-call-${sessionId}`,
      body: {
        connection_id: getTelnyxConnectionId(),
        to,
        from: getTelnyxCallerNumber(),
        client_state: clientState,
        webhook_url:
          `${process.env.PUBLIC_BASE_URL}/api/calls/telnyx-events`,
        webhook_url_method: "POST",
        answering_machine_detection: "disabled",
      },
    });

    const callData = result.data || {};
    const callControlId = callData.call_control_id || null;
    const callLegId = callData.call_leg_id || null;
    const callSessionId = callData.call_session_id || null;

    await db.query(
      `
      UPDATE call_sessions
      SET provider = 'telnyx',
          provider_call_id = $2,
          provider_status = $3,
          meta = COALESCE(meta, '{}'::jsonb) ||
                 jsonb_build_object(
                   'telnyx_call_leg_id', $4::text,
                   'telnyx_call_session_id', $5::text
                 ) WHERE id = $1 `,
    [
        sessionId,
        callControlId,
        "initiated",
        callLegId,
        callSessionId,
      ]
    );

    return {
      ok: true,
      callControlId,
      callLegId,
      callSessionId,
      status: "initiated",
      raw: callData,
    };
  } catch (error) {
    console.error(
      "❌ TELNYX MAKE CALL ERROR:",
      error.telnyxResponse || error
    );

    return {
      ok: false,
      error: error.message,
    };
  }
}

async function hangupCall({ callControlId }) {
  if (!callControlId) {
    return {
      ok: false,
      error: "callControlId is required",
    };
  }

  try {
    const result = await telnyxRequest({
      path: `/calls/${encodeURIComponent(callControlId)}/actions/hangup`,
      method: "POST",
      body: {},
    });

    return {
      ok: true,
      data: result.data || result,
    };
  } catch (error) {
    console.error(
      "❌ TELNYX HANGUP ERROR:",
      error.telnyxResponse || error
    );

    return {
    ok:false,
    error:error.message,
    details:error.telnyxResponse || null
    }
  }
}

module.exports = {
  makeCall,
  hangupCall,
  telnyxRequest,
};