/**
 * calls.controller.js
 * --------------------------------------------------
 * NetPhone Calling Controller
 *
 * Provider: Telnyx
 *
 * Responsibilities:
 * 1. Resolve route, rate and wallet eligibility
 * 2. Create immutable call session
 * 3. Start real Telnyx outbound call
 * 4. Receive Telnyx webhook events
 * 5. Store provider call status
 * 6. Return authenticated call status
 * 7. End active Telnyx call
 */

const {
  startCallSession,
  endCallAndCharge,
} = require("./calls.service");

const {
  makeCall,
  hangupCall,
} = require("./telnyx.service");

const db = require("../../config/db");

const {
  issueWebrtcToken,
} = require("./telnyx-webrtc.service");


/**
 * Decode Telnyx client_state safely.
 *
 * Telnyx sends client_state as a Base64/Base64URL encoded string.
 * This helper also supports plain JSON for backward compatibility.
 */
function decodeTelnyxClientState(rawClientState) {
  if (rawClientState === null || rawClientState === undefined) {
    return null;
  }

  const rawValue = String(rawClientState).trim();

  if (!rawValue) {
    return null;
  }

  const candidates = [rawValue];

  // Preferred decoding for URL-safe Base64 strings such as eyJ...
  try {
    const decodedBase64Url = Buffer.from(
      rawValue,
      "base64url",
    )
      .toString("utf8")
      .trim();

    if (decodedBase64Url) {
      candidates.push(decodedBase64Url);
    }
  } catch (error) {
    console.warn(
      "⚠️ TELNYX CLIENT STATE BASE64URL DECODE WARNING:",
      error.message,
    );
  }

  // Compatibility fallback for standard Base64.
  try {
    const normalizedBase64 = rawValue
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    const paddedBase64 = normalizedBase64.padEnd(
      Math.ceil(normalizedBase64.length / 4) * 4,
      "=",
    );

    const decodedBase64 = Buffer.from(
      paddedBase64,
      "base64",
    )
      .toString("utf8")
      .trim();

    if (decodedBase64) {
      candidates.push(decodedBase64);
    }
  } catch (error) {
    console.warn(
      "⚠️ TELNYX CLIENT STATE BASE64 DECODE WARNING:",
      error.message,
    );
  }

  for (const candidate of candidates) {
    try {
      let parsed = JSON.parse(candidate);

      // Also support a JSON string containing another JSON object.
      if (typeof parsed === "string") {
        parsed = JSON.parse(parsed);
      }

      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed;
      }
    } catch (_) {
      // Try the next candidate.
    }
  }

  return null;
}


/**
 * Mark a created session as failed.
 */
async function markSessionFailed({
  sessionId,
  errorKey,
  errorMessage,
}) {
  if (!sessionId) {
    return;
  }

  await db.query(
    `
      UPDATE call_sessions
      SET
        status = 'failed',
        provider = 'telnyx',
        provider_status = 'failed',
        meta = COALESCE(meta, '{}'::jsonb) ||
               jsonb_build_object(
                 $2::text,
                 $3::text
               )
      WHERE id = $1
    `,
    [
      sessionId,
      errorKey,
      errorMessage || "Unknown Telnyx call error",
    ]
  );
}

/**
 * Read the current call session after Telnyx service updates it.
 */
async function getFreshCallSession({
  sessionId,
  userId,
}) {
  const { rows } = await db.query(
    `
      SELECT *
      FROM call_sessions
      WHERE id = $1
        AND user_id = $2
      LIMIT 1
    `,
    [sessionId, userId]
  );

  return rows[0] || null;
}

/**
 * Return a short-lived Telnyx WebRTC JWT
 * to an authenticated Flutter user.
 */
async function getWebrtcToken(req, res) {
  try {
    const userId =
      Number(req.user?.id);

    if (
      !Number.isInteger(userId) ||
      userId <= 0
    ) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized user",
      });
    }

    if (
      req.user?.status &&
      req.user.status !== "active"
    ) {
      return res.status(403).json({
        ok: false,
        message: "User is not active",
      });
    }

    const tokenResult =
      await issueWebrtcToken({
        userId,
      });

    return res.status(200).json({
      ok: true,

      token:
        tokenResult.token,

      token_type:
        "telnyx_webrtc_jwt",

      caller_id_name:
        "NetPhone",

      caller_id_number:
        String(
          process.env.TELNYX_PHONE_NUMBER ||
          ""
        ).trim(),

      credential_expires_at:
        tokenResult.credentialExpiresAt,
    });
  } catch (error) {
    console.error(
      "❌ TELNYX WEBRTC TOKEN ERROR:",
      {
        message:
          error.message,

        statusCode:
          error.statusCode || null,

        telnyxResponse:
          error.telnyxResponse || null,

        stack:
          error.stack,
      }
    );

    return res.status(
      error.statusCode || 500
    ).json({
      ok: false,

      message:
        error.message ||
        "Unable to create WebRTC token",
    });
  }
}

/**
 * Production Flutter WebRTC call-session endpoint.
 *
 * This endpoint does NOT create a Telnyx PSTN call.
 * Flutter Telnyx WebRTC SDK creates the actual call.
 *
 * Responsibilities:
 * 1. Validate destination
 * 2. Resolve provider route and rate
 * 3. Validate wallet
 * 4. Create immutable call session
 * 5. Return WebRTC correlation data
 */
async function startCall(req, res) {
  try {
    console.log(
      "📞 WEBRTC START CALL BODY =>",
      req.body
    );

    console.log(
      "📞 WEBRTC START CALL USER =>",
      req.user
    );

    const userId =
      Number(req.user?.id);

    const {
      to_phone_e164,
      meta,
    } = req.body || {};

    if (
      !Number.isInteger(userId) ||
      userId <= 0
    ) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized user",
      });
    }

    if (
      typeof to_phone_e164 !== "string" ||
      !to_phone_e164.trim()
    ) {
      return res.status(400).json({
        ok: false,
        message: "to_phone_e164 required",
      });
    }

    const destination =
      to_phone_e164.trim();

    const sessionResult =
      await startCallSession({
        userId,

        toPhoneE164:
          destination,

        meta: {
          ...(meta || {}),

          provider:
            "telnyx",

          initiation_type:
            "flutter_webrtc",

          media_source:
            "telnyx_flutter_sdk",
        },
      });

    console.log(
      "✅ WEBRTC CALL SESSION RESULT =>",
      sessionResult
    );

    if (!sessionResult.ok) {
      return res.status(400).json({
        ok: false,

        reason:
          sessionResult.reason,

        message:
          sessionResult.message ||
          sessionResult.reason ||
          "Unable to create call session",

        routing:
          sessionResult.routing || null,
      });
    }

    const sessionId =
      Number(
        sessionResult.session?.id
      );

    if (
      !Number.isInteger(sessionId) ||
      sessionId <= 0
    ) {
      return res.status(500).json({
        ok: false,

        reason:
          "invalid_session_id",

        message:
          "Call session was created without a valid id",
      });
    }

    /*
     * Flutter passes this value into the Telnyx SDK
     * call client_state field.
     *
     * Telnyx webhook returns it so the Backend can
     * correlate the provider call with call_sessions.id.
     */
const clientState = JSON.stringify({
  session_id: sessionId,
  user_id: userId,
});

    await db.query(
      `
        UPDATE call_sessions
        SET
          provider = 'telnyx',

          provider_status =
            'webrtc_session_created',

          meta =
            COALESCE(
              meta,
              '{}'::jsonb
            ) ||
            jsonb_build_object(
              'webrtc_client_state',
              $2::text,

              'webrtc_session_created_at',
              NOW()::text
            )

        WHERE id = $1::bigint
      `,
      [
        sessionId,
        clientState,
      ]
    );

    const refreshedSession =
      await getFreshCallSession({
        sessionId,
        userId,
      });

    return res.status(201).json({
      ok: true,

      session:
        refreshedSession ||
        sessionResult.session,

      routing:
        sessionResult.routing || null,

      webrtc: {
        provider:
          "telnyx",

        destination,

        client_state:
          clientState,

        caller_id_name:
          "NetPhone",

        caller_id_number:
          String(
            process.env.TELNYX_PHONE_NUMBER ||
            ""
          ).trim(),
      },
    });
  } catch (error) {
    console.error(
      "❌ WEBRTC CALL SESSION ERROR:",
      {
        message:
          error.message,

        code:
          error.code || null,

        stack:
          error.stack,
      }
    );

    return res.status(500).json({
      ok: false,

      reason:
        "call_session_exception",

      message:
        error.message ||
        "Unable to create WebRTC call session",
    });
  }
}

/**
 * Temporary server-originated Telnyx outbound-call test.
 *
 * This endpoint creates a PSTN call from Telnyx.
 * It does not connect Flutter microphone/audio.
 * Flutter live two-way audio requires Telnyx WebRTC SDK.
 */
async function startTelnyxOutboundCall(req, res) {
  let sessionId = null;

  try {
    console.log(
      "📞 TELNYX START BODY =>",
      req.body
    );

    console.log(
      "📞 TELNYX START USER =>",
      req.user
    );

    const userId = req.user?.id;
    const { to_phone_e164, meta } =
      req.body || {};

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized user",
      });
    }

    if (
      typeof to_phone_e164 !== "string" ||
      !to_phone_e164.trim()
    ) {
      return res.status(400).json({
        ok: false,
        message: "to_phone_e164 required",
      });
    }

    const destination =
      to_phone_e164.trim();

    const sessionResult =
      await startCallSession({
        userId,
        toPhoneE164: destination,
        meta: {
          ...(meta || {}),
          provider: "telnyx",
          initiation_type:
            "server_api_test",
        },
      });

    if (!sessionResult.ok) {
      return res.status(400).json({
        ok: false,
        reason:
          sessionResult.reason,
        message:
          sessionResult.message ||
          sessionResult.reason ||
          "Unable to create call session",
        routing:
          sessionResult.routing || null,
      });
    }

    sessionId =
      Number(sessionResult.session?.id);

    if (
      !Number.isInteger(sessionId) ||
      sessionId <= 0
    ) {
      return res.status(500).json({
        ok: false,
        reason: "invalid_session_id",
        message:
          "Call session was created without a valid id",
      });
    }

    const callResult = await makeCall({
      to: destination,
      sessionId,
    });

    console.log(
      "📞 TELNYX TEST CALL RESULT =>",
      {
        ok:
          callResult?.ok === true,
        callControlId:
          callResult?.callControlId ||
          null,
        callLegId:
          callResult?.callLegId ||
          null,
        callSessionId:
          callResult?.callSessionId ||
          null,
        status:
          callResult?.status || null,
        error:
          callResult?.error || null,
      }
    );

    if (
      !callResult?.ok ||
      !callResult.callControlId
    ) {
      const providerError =
        callResult?.error ||
        "Telnyx outbound call failed";

      await markSessionFailed({
        sessionId,
        errorKey: "telnyx_test_error",
        errorMessage: providerError,
      });

      return res.status(502).json({
        ok: false,
        reason: "provider_call_failed",
        message: providerError,
        session_id: sessionId,
        provider_details:
          callResult?.details || null,
      });
    }

    const refreshedSession =
      await getFreshCallSession({
        sessionId,
        userId,
      });

    return res.status(201).json({
      ok: true,
      session:
        refreshedSession ||
        sessionResult.session,
      provider: {
        name: "telnyx",
        call_control_id:
          callResult.callControlId,
        call_leg_id:
          callResult.callLegId,
        call_session_id:
          callResult.callSessionId,
        status:
          callResult.status,
      },
      routing:
        sessionResult.routing || null,
    });
  } catch (error) {
    console.error(
      "❌ TELNYX START CALL ERROR:",
      {
        message:
          error.message,
        statusCode:
          error.statusCode || null,
        telnyxResponse:
          error.telnyxResponse || null,
        stack:
          error.stack,
      }
    );

    if (sessionId) {
      try {
        await markSessionFailed({
          sessionId,
          errorKey:
            "telnyx_test_controller_error",
          errorMessage:
            error.message,
        });
      } catch (databaseError) {
        console.error(
          "❌ FAILED TO SAVE TELNYX ERROR:",
          databaseError
        );
      }
    }

    return res.status(500).json({
      ok: false,
      reason: "telnyx_test_exception",
      message:
        error.message ||
        "Telnyx outbound call failed",
    });
  }
}

/**
 * User call end request.
 *
 * If provider_call_id exists, the active Telnyx call
 * is terminated before the session end service runs.
 */
/**
 * End a user call safely and idempotently.
 */
async function endCall(req, res) {
  try {
    console.log("📴 END CALL USER =>", req.user);
    console.log("📴 END CALL PARAMS =>", req.params);

    const userId = Number(req.user?.id);
    const sessionId = Number(req.params.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized user",
      });
    }

    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res.status(400).json({
        ok: false,
        message: "Invalid session id",
      });
    }

    const { rows } = await db.query(
      `
        SELECT
          id,
          status,
          provider,
          provider_call_id,
          provider_status,
          ended_at,
          charged_amount_cents
        FROM call_sessions
        WHERE id = $1::bigint
          AND user_id = $2::bigint
        LIMIT 1
      `,
      [sessionId, userId]
    );

    if (!rows.length) {
      return res.status(404).json({
        ok: false,
        message: "Call session not found",
      });
    }

    const callSession = rows[0];

    const alreadyEnded =
      callSession.status === "ended" ||
      callSession.status === "charged" ||
      callSession.provider_status === "completed" ||
      callSession.ended_at != null;

    let providerHangupResult = {
      ok: true,
      skipped: true,
      reason: "Provider call already ended",
    };

    if (
      !alreadyEnded &&
      callSession.provider === "telnyx" &&
      callSession.provider_call_id
    ) {
      providerHangupResult = await hangupCall({
        callControlId: callSession.provider_call_id,
      });

      /*
       * Telnyx 90018 means the call is already ended.
       * Treat it as an idempotent success.
       */
      if (
        providerHangupResult?.ok === false &&
        String(providerHangupResult?.errorCode || "") === "90018"
      ) {
        providerHangupResult = {
          ok: true,
          alreadyEnded: true,
          providerCode: "90018",
        };
      }
    }

    const result = await endCallAndCharge({
      userId,
      sessionId,
    });

    /*
     * A repeated end request must not become a server error.
     */
    if (!result.ok) {
      const idempotentReasons = new Set([
        "already_ended",
        "already_charged",
        "call_already_ended",
      ]);

      if (!idempotentReasons.has(String(result.reason || ""))) {
        return res.status(400).json({
          ok: false,
          reason: result.reason,
          message:
            result.message ||
            result.reason ||
            "Unable to end call",
          provider_hangup: providerHangupResult,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      already_ended: alreadyEnded,
      charged_amount_cents:
        result.charged_amount_cents ??
        callSession.charged_amount_cents ??
        0,
      wallet: result.wallet ?? null,
      tx: result.tx ?? null,
      provider_hangup: providerHangupResult,
    });
  } catch (error) {
    console.error("❌ CALL END ERROR:", {
      message: error.message,
      code: error.code || null,
      stack: error.stack,
    });

    return res.status(500).json({
      ok: false,
      message: error.message || "Unable to end call",
    });
  }
}

/**
 * Manual test endpoint is disabled in production.
 */
async function testCall(req, res) {
  return res.status(403).json({
    ok: false,
    message:
      "Test call disabled in production",
  });
}

/**
 * Telnyx Voice API webhook.
 *
 * Expected events include:
 * - call.initiated
 * - call.ringing
 * - call.answered
 * - call.hangup
 */
async function telnyxStatusCallback(req, res) {
  try {
    const event =
      req.body?.data || null;

    const eventType =
      String(
        event?.event_type || ""
      ).trim();

    const payload =
      event?.payload || {};

    console.log(
      "📞 TELNYX WEBHOOK EVENT =>",
      {
        eventType,
        payload,
      }
    );

    /*
     * Return HTTP 200 for malformed or unsupported
     * events so Telnyx does not continuously retry them.
     */
    if (!eventType) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Missing event type",
      });
    }

    const decodedClientState =
  decodeTelnyxClientState(
    payload.client_state
  );

if (
  payload.client_state &&
  !decodedClientState
) {
  console.warn(
    "⚠️ TELNYX CLIENT STATE COULD NOT BE DECODED",
    {
      eventType,
      hasClientState: true,
    }
  );
}

const rawSessionId =
  decodedClientState?.session_id ??
  decodedClientState?.sessionId ??
  decodedClientState?.call_session_id ??
  decodedClientState?.callSessionId ??
  req.query?.SessionId ??
  req.body?.SessionId ??
  null;

const parsedSessionId =
  Number(rawSessionId);

const sessionId =
  Number.isInteger(parsedSessionId) &&
  parsedSessionId > 0
    ? parsedSessionId
    : 0;

console.log(
  "🔗 TELNYX CLIENT STATE RESULT =>",
  {
    eventType,
    decoded:
      Boolean(decodedClientState),

    sessionId:
      sessionId || null,

    keys:
      decodedClientState
        ? Object.keys(decodedClientState)
        : [],
  }
);

    const callControlId =
      payload.call_control_id
        ? String(
            payload.call_control_id
          )
        : null;

    const callLegId =
      payload.call_leg_id
        ? String(
            payload.call_leg_id
          )
        : null;

    const callSessionId =
      payload.call_session_id
        ? String(
            payload.call_session_id
          )
        : null;

    const hangupCause =
      payload.hangup_cause ||
      payload.hangup_source ||
      null;

    let providerStatus =
      eventType
        .replace(/^call\./, "")
        .trim();

    let internalStatus = null;

    if (
      eventType === "call.initiated"
    ) {
      providerStatus = "initiated";
    }

    if (
      eventType === "call.ringing"
    ) {
      providerStatus = "ringing";
    }

    if (
      eventType === "call.answered"
    ) {
      providerStatus = "answered";
      internalStatus = "started";
    }

    if (
      eventType === "call.hangup"
    ) {
      providerStatus = "completed";
      internalStatus = "ended";
    }

    /*
     * A webhook may arrive before makeCall() finishes
     * persisting provider_call_id.
     *
     * The encoded session id lets us safely locate the
     * record during that race condition.
     */
    if (
      sessionId > 0 ||
      callControlId
    ) {
      const updateResult =
        await db.query(
          `
            UPDATE call_sessions
            SET
              provider =
                'telnyx',

              provider_call_id =
                COALESCE(
                  $2::text,
                  provider_call_id
                ),

              provider_status =
                $3::text,

              answered_at =
                CASE
                  WHEN $4::text =
                       'call.answered'
                  THEN COALESCE(
                    answered_at,
                    NOW()
                  )
                  ELSE answered_at
                END,

              ended_at =
                CASE
                  WHEN $4::text =
                       'call.hangup'
                  THEN COALESCE(
                    ended_at,
                    NOW()
                  )
                  ELSE ended_at
                END,

              status =
                CASE
                  WHEN $9::text
                       IS NOT NULL
                  THEN $9::text
                  ELSE status
                END,

              status_callback_payload =
                $5::jsonb,

              meta =
                COALESCE(
                  meta,
                  '{}'::jsonb
                ) ||
                jsonb_build_object(
                  'telnyx_call_leg_id',
                  COALESCE(
                    $6::text,
                    ''
                  ),

                  'telnyx_call_session_id',
                  COALESCE(
                    $7::text,
                    ''
                  ),

                  'telnyx_last_event',
                  $4::text,

                  'telnyx_hangup_cause',
                  COALESCE(
                    $8::text,
                    ''
                  )
                )

            WHERE
              (
                $1::bigint > 0
                AND id =
                    $1::bigint
              )
              OR
              (
                $2::text
                    IS NOT NULL
                AND provider_call_id =
                    $2::text
              )

            RETURNING
              id,
              user_id,
              status,
              provider_status,
              provider_call_id
          `,
          [
            sessionId,
            callControlId,
            providerStatus,
            eventType,
            JSON.stringify(req.body),
            callLegId,
            callSessionId,
            hangupCause,
            internalStatus,
          ]
        );

      console.log(
        "✅ TELNYX WEBHOOK SESSION UPDATE =>",
        {
          eventType,
          sessionId:
            sessionId || null,
          callControlId,
          updatedRows:
            updateResult.rowCount,
          session:
            updateResult.rows[0] ||
            null,
        }
      );
    } else {
    console.warn(
        "⚠️ TELNYX WEBHOOK SESSION NOT IDENTIFIED:",
      {
        eventType,
        decodedClientState:
        decodedClientState || null,
        callControlId,
  }
);
    }

    /*
     * Final wallet charging is intentionally not
     * triggered here until Telnyx billable duration/CDR
     * reconciliation has been completed.
     */
    return res.status(200).json({
      ok: true,

      event_type:
        eventType,

      session_id:
        sessionId || null,

      provider_call_id:
        callControlId,
    });
  } catch (error) {
    console.error(
      "❌ TELNYX WEBHOOK ERROR:",
      {
        message:
          error.message,

        code:
          error.code || null,

        detail:
          error.detail || null,

        stack:
          error.stack,
      }
    );

    return res.status(500).json({
      ok: false,

      message:
        error.message ||
        "Telnyx webhook processing failed",
    });
  }
}

/**
 * Return authenticated user's call status.
 */
/**
 * Authenticated user call status.
 */
async function getCallStatus(req, res) {
  try {
    const userId = Number(req.user?.id);
    const sessionId = Number(req.params.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized user",
      });
    }

    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res.status(400).json({
        ok: false,
        message: "Invalid session id",
      });
    }

    const { rows } = await db.query(
      `
        SELECT
          id,
          user_id,
          to_phone_e164,
          status,
          provider,
          provider_call_id,
          provider_status,
          answered_at,
          ended_at,
          duration_sec,
          charged_minutes,
          charged_amount_cents,
          billing_source,
          price_per_min_cents,
          provider_rate_usd_per_min,
          sell_rate_usd_per_min
        FROM call_sessions
        WHERE id = $1::bigint
          AND user_id = $2::bigint
        LIMIT 1
      `,
      [sessionId, userId]
    );

    if (!rows.length) {
      return res.status(404).json({
        ok: false,
        message: "Call not found",
      });
    }

    return res.status(200).json({
      ok: true,
      call: rows[0],
    });
  } catch (error) {
    console.error("❌ GET CALL STATUS ERROR:", {
      message: error.message,
      code: error.code || null,
      stack: error.stack,
    });

    return res.status(500).json({
      ok: false,
      message: error.message || "Unable to read call status",
    });
  }
}

module.exports = {
  startCall,
  getWebrtcToken,
  startTelnyxOutboundCall,
  endCall,
  testCall,
  telnyxStatusCallback,
  getCallStatus,
};
