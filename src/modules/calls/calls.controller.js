/**
 * calls.controller.js
 * --------------------------------------------------
 * NetPhone Calling Controller
 *
 * Provider: Telnyx
 *
 * দায়িত্ব:
 * 1. Call session তৈরি করা
 * 2. Telnyx test outbound call শুরু করা
 * 3. Telnyx webhook event গ্রহণ করা
 * 4. Call status database-এ সংরক্ষণ করা
 * 5. User-এর call status return করা
 * 6. Call session end করা
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
 * Telnyx client_state decode করে।
 *
 * Telnyx-এ client_state সাধারণত Base64-encoded string হিসেবে
 * webhook payload-এ ফেরত আসে।
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
 * Flutter app-এর জন্য call session তৈরি করে।
 *
 * গুরুত্বপূর্ণ:
 * এই endpoint এখন শুধু database session তৈরি করে।
 * Telnyx Android WebRTC SDK যুক্ত হওয়ার পরে mobile audio call
 * এই session-এর সঙ্গে connect করা হবে।
 */
async function startCall(req, res) {
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

    const result = await startCallSession({
      userId,
      toPhoneE164: to_phone_e164.trim(),
      meta: meta || null,
    });

    console.log("✅ START CALL SESSION RESULT =>", result);

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        reason: result.reason,
        message:
          result.message ||
          result.reason ||
          "Unable to start call session",
      });
    }

    return res.status(201).json({
      ok: true,
      session: result.session,
    });
  } catch (error) {
    console.error("❌ CALL SESSION START ERROR:", error);

    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
}

/**
 * Temporary Backend Telnyx outbound-call test.
 *
 * সতর্কতা:
 * এটি Telnyx থেকে destination number-এ একটি server-originated
 * PSTN call তৈরি করবে। Flutter phone-এর live microphone/audio
 * এতে নিজে থেকে যুক্ত হবে না।
 *
 * Flutter two-way audio-এর জন্য পরবর্তী ধাপে Telnyx Android
 * WebRTC SDK integration প্রয়োজন।
 */
async function startTelnyxOutboundCall(req, res) {
  let sessionId = null;

  try {
    console.log("📞 TELNYX START BODY =>", req.body);
    console.log("📞 TELNYX START USER =>", req.user);

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

    const sessionResult = await startCallSession({
      userId,
      toPhoneE164: to_phone_e164.trim(),
      meta: {
        ...(meta || {}),
        provider: "telnyx",
        initiation_type: "server_api_test",
      },
    });

    if (!sessionResult.ok) {
      return res.status(400).json({
        ok: false,
        reason: sessionResult.reason,
        message:
          sessionResult.message ||
          sessionResult.reason ||
          "Unable to create call session",
      });
    }

    sessionId = Number(sessionResult.session.id);

    const callResult = await makeCall({
      to: to_phone_e164.trim(),
      sessionId,
    });

    if (!callResult.ok) {
      await db.query(
        `
        UPDATE call_sessions
        SET status = 'failed',
            provider = 'telnyx',
            provider_status = 'failed',
            meta = COALESCE(meta, '{}'::jsonb) ||
                   jsonb_build_object(
                     'telnyx_error',
                     $2::text
                   )
        WHERE id = $1
        `,
        [
          sessionId,
          callResult.error || "Telnyx call failed",
        ]
      );

      return res.status(502).json({
        ok: false,
        message:
          callResult.error ||
          "Telnyx outbound call failed",
        session_id: sessionId,
      });
    }

    return res.status(201).json({
      ok: true,
      session: sessionResult.session,
      provider: {
        name: "telnyx",
        call_control_id: callResult.callControlId,
        call_leg_id: callResult.callLegId,
        call_session_id: callResult.callSessionId,
        status: callResult.status,
      },
    });
  } catch (error) {
    console.error("❌ TELNYX START CALL ERROR:", error);

    if (sessionId) {
      try {
        await db.query(
          `
          UPDATE call_sessions
          SET status = 'failed',
              provider = 'telnyx',
              provider_status = 'failed',
              meta = COALESCE(meta, '{}'::jsonb) ||
                     jsonb_build_object(
                       'telnyx_controller_error',
                       $2::text
                     )
          WHERE id = $1
          `,
          [sessionId, error.message]
        );
      } catch (databaseError) {
        console.error(
          "❌ FAILED TO SAVE TELNYX ERROR:",
          databaseError
        );
      }
    }

    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
}

/**
 * User call end request.
 *
 * provider_call_id থাকলে Telnyx call-ও hangup করার চেষ্টা করবে।
 * এরপর existing wallet/session end service চালাবে।
 */
async function endCall(req, res) {
  try {
    console.log("📴 END CALL USER =>", req.user);
    console.log("📴 END CALL PARAMS =>", req.params);

    const userId = req.user?.id;
    const sessionId = Number(req.params.id);

    if (!userId) {
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
        provider,
        provider_call_id
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
        message: "Call session not found",
      });
    }

    const callSession = rows[0];
    let providerHangupResult = null;

    if (
      callSession.provider === "telnyx" &&
      callSession.provider_call_id
    ) {
      providerHangupResult = await hangupCall({
        callControlId: callSession.provider_call_id,
      });
    }

    const result = await endCallAndCharge({
      userId,
      sessionId,
    });

    if (!result.ok) {
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

    return res.json({
      ok: true,
      charged_amount_cents:
        result.charged_amount_cents,
      wallet: result.wallet,
      tx: result.tx,
      provider_hangup: providerHangupResult,
    });
  } catch (error) {
    console.error("❌ CALL END ERROR:", error);

    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
}

/**
 * Production-এ manual test endpoint বন্ধ।
 */
async function testCall(req, res) {
  return res.status(403).json({
    ok: false,
    message: "Test call disabled in production",
  });
}

/**
 * Telnyx Voice API webhook.
 *
 * Expected event examples:
 * - call.initiated
 * - call.ringing
 * - call.answered
 * - call.hangup
 *
 * Telnyx webhook body:
 * {
 *   data: {
 *     event_type: "...",
 *     payload: {...}
 *   }
 * }
 */
async function telnyxStatusCallback(req, res) {
  try {
    const event = req.body?.data;
    const eventType = event?.event_type;
    const payload = event?.payload || {};

    console.log("📞 TELNYX WEBHOOK EVENT =>", {
      eventType,
      payload,
    });

    /*
     * Telnyx webhook delivery যেন retry না করে,
     * malformed/unknown event-ও 200 দিয়ে ignore করা হচ্ছে।
     */
    if (!eventType) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Missing event type",
      });
    }

    const clientState = decodeTelnyxClientState(
      payload.client_state
    );

    const sessionId = Number(
      clientState.session_id ||
      req.query.SessionId ||
      req.body?.SessionId ||
      0
    );

    const callControlId =
      payload.call_control_id || null;

    const callLegId =
      payload.call_leg_id || null;

    const callSessionId =
      payload.call_session_id || null;

    let providerStatus = String(eventType)
      .replace(/^call\./, "")
      .trim();

    if (eventType === "call.answered") {
      providerStatus = "answered";
    }

    if (eventType === "call.hangup") {
      providerStatus = "completed";
    }

    /*
     * sessionId অথবা provider_call_id—যেটি পাওয়া যায়,
     * সেটি দিয়ে session update হবে।
     */
    if (sessionId > 0 || callControlId) {
      await db.query(
        `
        UPDATE call_sessions
        SET provider = 'telnyx',

            provider_call_id =
              COALESCE($2, provider_call_id),

            provider_status = $3,

            answered_at = CASE
              WHEN $4 = 'call.answered'
              THEN COALESCE(answered_at, NOW())
              ELSE answered_at
            END,

            ended_at = CASE
              WHEN $4 = 'call.hangup'
              THEN COALESCE(ended_at, NOW())
              ELSE ended_at
            END,

            status = CASE
              WHEN $4 = 'call.answered'
              THEN 'started'

              WHEN $4 = 'call.hangup'
              THEN 'ended'

              ELSE status
            END,

            status_callback_payload = $5::jsonb,

            meta = COALESCE(meta, '{}'::jsonb) ||
                   jsonb_build_object(
                     'telnyx_call_leg_id',
                     COALESCE($6::text, ''),

                     'telnyx_call_session_id',
                     COALESCE($7::text, ''),

                     'telnyx_last_event',
                     $4::text,

                     'telnyx_hangup_cause',
                     COALESCE($8::text, '')
                   )

        WHERE
          ($1 > 0 AND id = $1)
          OR
          ($2 IS NOT NULL AND provider_call_id = $2)
        `,
        [
          sessionId,
          callControlId,
          providerStatus,
          eventType,
          JSON.stringify(req.body),
          callLegId,
          callSessionId,
          payload.hangup_cause || null,
        ]
      );
    }

    /*
     * এখনই webhook duration দিয়ে wallet charge করা হচ্ছে না।
     *
     * কারণ Telnyx call.hangup payload এবং Telnyx CDR-এর
     * billable duration/cost যাচাই না করে user wallet charge করলে
     * ভুল billing হতে পারে।
     *
     * Final Telnyx billing/CDR integration-এর সময় এটি করা হবে।
     */
    return res.status(200).json({
      ok: true,
      event_type: eventType,
      session_id: sessionId || null,
    });
  } catch (error) {
    console.error(
      "❌ TELNYX WEBHOOK ERROR:",
      error
    );

    /*
     * Development অবস্থায় error বোঝার জন্য 500 রাখা হলো।
     * Signature verification ও idempotent event processing
     * যুক্ত করার পরে production retry handling final হবে।
     */
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
}

/**
 * Authenticated user-এর call status।
 */
async function getCallStatus(req, res) {
  try {
    const userId = req.user?.id;
    const sessionId = Number(req.params.id);

    if (!userId) {
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
        answered_at,
        ended_at,
        duration_sec,
        charged_minutes,
        charged_amount_cents,
        billing_source
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
      message: error.message,
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