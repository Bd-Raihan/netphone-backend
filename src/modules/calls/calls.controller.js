
// ✅ calls.controller.js
const {
  startCallSession,
  endCallAndCharge,
  billCompletedCallBySid,
} = require("./calls.service");

// ✅ Twilio Voice API
const { makeCall } = require("./twilio.service");

const db = require("../../config/db");


// ✅ START CALL
async function startCall(req, res) {
  try {
    console.log("📞 START CALL BODY =>", req.body);
    console.log("📞 START CALL USER =>", req.user);
    // ✅ auth.jwt.js থেকে আসে
    const userId = req.user.id;
    const { to_phone_e164, meta } = req.body || {};
    // validation
    if (!to_phone_e164) {
      return res.status(400).json({
        ok: false,
        message: "to_phone_e164 required",
      });
    }
    // service call
    const result = await startCallSession({
      userId,
      toPhoneE164: to_phone_e164,
      meta: meta || null,
    });
    console.log("❌ START CALL FAILED =>", result);
      if (!result.ok) {
      return res.status(400).json({
        ok: false,
        reason: result.reason,
      });
    }
    // session ok হলে তারপর provider call হবে
    const twilioResult = await makeCall({
      to: to_phone_e164,
        sessionId: result.session.id,
      });
    if (!twilioResult.ok) {
      return res.status(502).json({
        ok: false,
        reason: "provider_call_failed",
        provider_error: twilioResult.error,
      });
    }
    // success
    return res.json({
      ok: true,
      session: result.session,
      twilio: twilioResult,
    });
  } catch (e) {
    // ✅ IMPORTANT DEBUG
    console.error("❌ CALL START ERROR:", e);
    return res.status(500).json({
      ok: false,
      message: e.message,
      stack: e.stack,
    });
  }
}

// ✅ END CALL
async function endCall(req, res) {
  try {
    console.log("📴 END CALL USER =>", req.user);
    console.log("📴 END CALL PARAMS =>", req.params);

    const userId = req.user.id;
    const sessionId = Number(req.params.id);

    // validation
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res.status(400).json({
      ok: false,
      message: "invalid session id",
      });
    }

    // service call
    const result = await endCallAndCharge({
      userId,
      sessionId,
    });

    // business fail
    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        reason: result.reason,
      });
    }

    // success
    return res.json({
      ok: true,
      charged_amount_cents: result.charged_amount_cents,
      wallet: result.wallet,
      tx: result.tx,
    });

  } catch (e) {
    // ✅ IMPORTANT DEBUG
    console.error("❌ CALL END ERROR:", e);

    return res.status(500).json({
      ok: false,
      message: e.message,
      stack: e.stack,
    });
  }
}

// ✅ TEST CALL (Twilio Voice API)
// ✅ TEST CALL disabled for production safety
async function testCall(req, res) {
  return res.status(403).json({
    ok: false,
    message: "Test call disabled in production",
  });
}


function twimlResponse(req, res) {
  res.type("text/xml");
  return res.send(`
  <Response>
    <Say voice="alice">Connecting your NetPhone call.</Say>
    <Pause length="1"/>
  </Response>
  `.trim());
  }


// ✅ TWILIO STATUS CALLBACK
// ✅ TWILIO STATUS CALLBACK - Call Billing Engine V2
async function twilioStatusCallback(req, res) {
  try {
    console.log("📞 TWILIO CALLBACK =>", req.body);

    const callSid = req.body.CallSid;
    const callStatus = req.body.CallStatus;
    const callDuration = Number(req.body.CallDuration || 0);

    if (!callSid) {
      return res.status(200).send("OK");
    }

    // answered event
    if (callStatus === "in-progress") {
      await require("../../config/db").query(
        `
        UPDATE call_sessions
        SET answered_at = COALESCE(answered_at, NOW()),
            provider_status = $2,
            status_callback_payload = $3
        WHERE twilio_call_sid = $1
        `,
        [callSid, callStatus, req.body]
      );

      return res.status(200).send("OK");
    }

    // completed event → billing হবে
    if (callStatus === "completed") {
      await billCompletedCallBySid({
        callSid,
        durationSec: callDuration,
        rawPayload: req.body,
      });

      return res.status(200).send("OK");
    }

    // initiated / ringing / busy / failed / no-answer
    await require("../../config/db").query(
      `
      UPDATE call_sessions
      SET provider_status = $2,
          status_callback_payload = $3
      WHERE twilio_call_sid = $1
      `,
      [callSid, callStatus, req.body]
    );

    return res.status(200).send("OK");
  } catch (e) {
    console.error("❌ TWILIO CALLBACK ERROR:", e);
    return res.status(500).send("ERROR");
  }
}

// ✅ GET CALL STATUS
async function getCallStatus(req, res) {
  try {
    const userId = req.user.id;
    const sessionId = Number(req.params.id);

    const { rows } = await db.query(
      `
      SELECT 
        id, status, provider_status, answered_at, ended_at,
        duration_sec, charged_minutes, charged_amount_cents
      FROM call_sessions
      WHERE id = $1 AND user_id = $2
      LIMIT 1
      `,
      [sessionId, userId]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, message: "Call not found" });
    }

    return res.json({ ok: true, call: rows[0] });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

module.exports = {
  startCall,
  endCall,
  testCall,
  twilioStatusCallback,
  twimlResponse,
  getCallStatus,
};