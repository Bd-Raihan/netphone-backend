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

/**
 * Decode Telnyx Base64 client_state.
 */
function decodeTelnyxClientState(encodedClientState) {
  if (!encodedClientState) {
    return {};
  }

  try {
    const decoded = Buffer.from(
      encodedClientState,
      "base64"
    ).toString("utf8");

    return JSON.parse(decoded);
  } catch (error) {
    console.error(
      "⚠️ TELNYX CLIENT STATE DECODE ERROR:",
      error.message
    );

    return {};
  }
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
 * Production Flutter call-start endpoint.
 *
 * Flow:
 * 1. Resolve route/rate/provider
 * 2. Validate wallet
 * 3. Create call_sessions record
 * 4. Send real call request to Telnyx
 * 5. Return fresh session with provider_call_id
 */
async function startCall(req, res) {
  let sessionId = null;

  try {
    console.log("📞 START CALL BODY =>", req.body);
    console.log("📞 START CALL USER =>", req.user);

    const userId = req.user?.id;
    const { to_phone_e164, meta } = req.body || {};

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

    const destination = to_phone_e164.trim();

    /*
     * Create routed/priced session first.
     */
    const sessionResult = await startCallSession({
      userId,
      toPhoneE164: destination,
      meta: {
        ...(meta || {}),
        provider: "telnyx",
        initiation_type: "production_server_api",
      },
    });

    console.log(
      "✅ START CALL SESSION RESULT =>",
      sessionResult
    );

    if (!sessionResult.ok) {
      return res.status(400).json({
        ok: false,
        reason: sessionResult.reason,
        message:
          sessionResult.message ||
          sessionResult.reason ||
          "Unable to start call session",
        routing: sessionResult.routing || null,
      });
    }

    sessionId = Number(sessionResult.session?.id);

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

    /*
     * The Flutter application uses /api/calls/start.
     * Therefore this endpoint must also dispatch the actual
     * Telnyx call—not merely create the database session.
     */
    const callResult = await makeCall({
      to: destination,
      sessionId,
    });

    console.log("📞 TELNYX MAKE CALL RESULT =>", {
      ok: callResult?.ok === true,
      callControlId:
        callResult?.callControlId || null,
      callLegId:
        callResult?.callLegId || null,
      callSessionId:
        callResult?.callSessionId || null,
      status:
        callResult?.status || null,
      error:
        callResult?.error || null,
      details:
        callResult?.details || null,
    });

    if (
      !callResult?.ok ||
      !callResult.callControlId
    ) {
      const providerError =
        callResult?.error ||
        "Telnyx did not return call_control_id";

      await markSessionFailed({
        sessionId,
        errorKey: "telnyx_error",
        errorMessage: providerError,
      });

      return res.status(502).json({
        ok: false,
        reason: "provider_call_failed",
        message: providerError,
        session_id: sessionId,
        provider: "telnyx",
        provider_details:
          callResult?.details || null,
      });
    }

    /*
     * makeCall() updates provider_call_id/provider_status.
     * Return a fresh row instead of the stale original session.
     */
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
    console.error("❌ CALL START ERROR:", {
      message:
        error.message,
      statusCode:
        error.statusCode || null,
      telnyxResponse:
        error.telnyxResponse || null,
      stack:
        error.stack,
    });

    if (sessionId) {
      try {
        await markSessionFailed({
          sessionId,
          errorKey: "telnyx_controller_error",
          errorMessage: error.message,
        });
      } catch (databaseError) {
        console.error(
          "❌ FAILED TO SAVE CALL START ERROR:",
          databaseError
        );
      }
    }

    return res.status(500).json({
      ok: false,
      reason: "call_start_exception",
      message:
        error.message ||
        "Call start failed",
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
async function endCall(req, res) {
  try {
    console.log(
      "📴 END CALL USER =>",
      req.user
    );

    console.log(
      "📴 END CALL PARAMS =>",
      req.params
    );

    const userId = req.user?.id;
    const sessionId =
      Number(req.params.id);

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized user",
      });
    }

    if (
      !Number.isInteger(sessionId) ||
      sessionId <= 0
    ) {
      return res.status(400).json({
        ok: false,
        message: "Invalid session id",
      });
    }

    const { rows } = await db.query(
      `
        SELECT
          id,
          provider,
          provider_call_id,
          provider_status,
          status
        FROM call_sessions
        WHERE id = $1
          AND user_id = $2
        LIMIT 1
      `,
      [sessionId, userId]
    );

    if (!rows.length) {
      return res.status(404).json({
        ok: false,
        message:
          "Call session not found",
      });
    }

    const callSession = rows[0];
    let providerHangupResult = null;

    if (
      callSession.provider === "telnyx" &&
      callSession.provider_call_id
    ) {
      providerHangupResult =
        await hangupCall({
          callControlId:
            callSession.provider_call_id,
        });

      console.log(
        "📴 TELNYX HANGUP RESULT =>",
        providerHangupResult
      );
    }

    const result =
      await endCallAndCharge({
        userId,
        sessionId,
      });

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        reason:
          result.reason,
        message:
          result.message ||
          result.reason ||
          "Unable to end call",
        provider_hangup:
          providerHangupResult,
      });
    }

    return res.json({
      ok: true,
      reason:
        result.reason || null,
      charged_amount_cents:
        result.charged_amount_cents ??
        null,
      wallet:
        result.wallet || null,
      tx:
        result.tx || null,
      provider_hangup:
        providerHangupResult,
    });
  } catch (error) {
    console.error(
      "❌ CALL END ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        "Unable to end call",
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
 * Expected examples:
 * - call.initiated
 * - call.ringing
 * - call.answered
 * - call.hangup
 */
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

    const clientState =
      decodeTelnyxClientState(
        payload.client_state
      );

    const rawSessionId =
      clientState.session_id ||
      req.query?.SessionId ||
      req.body?.SessionId ||
      0;

    const parsedSessionId =
      Number(rawSessionId);

    const sessionId =
      Number.isInteger(parsedSessionId) &&
      parsedSessionId > 0
        ? parsedSessionId
        : 0;

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
          clientState,
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
async function getCallStatus(req, res) {
  try {
    const userId = req.user?.id;
    const sessionId =
      Number(req.params.id);

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized user",
      });
    }

    if (
      !Number.isInteger(sessionId) ||
      sessionId <= 0
    ) {
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

          price_per_min_cents,
          sell_rate_usd_per_min,

          answered_at,
          ended_at,
          duration_sec,

          charged_minutes,
          charged_amount_cents,
          billing_source,

          created_at,
          updated_at
        FROM call_sessions
        WHERE id = $1
          AND user_id = $2
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

    return res.json({
      ok: true,
      call: rows[0],
    });
  } catch (error) {
    console.error(
      "❌ GET CALL STATUS ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        "Unable to read call status",
    });
  }
}

module.exports = {
  startCall,
  startTelnyxOutboundCall,
  endCall,
  testCall,
  telnyxStatusCallback,
  getCallStatus,
};
