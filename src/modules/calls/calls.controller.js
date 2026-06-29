
// ✅ calls.controller.js
const {
  startCallSession,
  endCallAndCharge,
  billCompletedCallBySid,
} = require("./calls.service");

// ✅ Twilio Voice API
const { makeCall } = require("./twilio.service");

const db = require("../../config/db");
const twilio = require ("twilio");


// ✅ START CALL
// ✅ START CALL
async function startCall(req, res) {
  try {
    console.log("📞 START CALL BODY =>", req.body);
    console.log("📞 START CALL USER =>", req.user);

    const userId = req.user.id;
    const { to_phone_e164, meta } = req.body || {};

    if (!to_phone_e164) {
      return res.status(400).json({
        ok: false,
        message: "to_phone_e164 required",
      });
    }

    const result = await startCallSession({
      userId,
      toPhoneE164: to_phone_e164,
      meta: meta || null,
    });

    console.log("✅ START CALL RESULT =>", result);

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        reason: result.reason,
      });
    }

    return res.json({
      ok: true,
      session: result.session,
    });
  } catch (e) {
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


// ✅ TWILIO VOICE SDK TOKEN
async function getVoiceToken(req, res) {
  try {
    let userId = req.user?.id;

  if (!userId && req.query.SessionId) {
    const sessionId = Number(req.query.SessionId);

    const { rows } = await db.query(
      `SELECT user_id FROM call_sessions WHERE id = $1 LIMIT 1`,
      [sessionId]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, message: "session not found" });
    }

      userId = rows[0].user_id;
    }

    if (!userId) {
      return res.status(401).json({ ok: false, message: "missing user" });
    }
    const identity = `user_${userId}`;

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY_SID,
      process.env.TWILIO_API_KEY_SECRET,
      { identity }
    );

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
      incomingAllow: false,
    });

    token.addGrant(voiceGrant);

  return res.json({
  ok: true,
  identity,
  token: token.toJwt(),
});

    
  } catch (e) {
    console.error("❌ VOICE TOKEN ERROR:", e);
    return res.status(500).json({ ok: false, message: e.message });
  }
}


// ✅ TWIML RESPONSE
async function twimlResponse(req, res) {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  console.log("📞 TWIML BODY =>", req.body);

  const toPhoneNumber =
    req.body.To || req.body.to || req.query.To || req.query.to;

  const sessionId = Number(
    req.body.SessionId || req.body.sessionId || req.query.SessionId || 0
  );

  const callSid = req.body.CallSid;

  if (sessionId > 0 && callSid) {
    await db.query(
      `
      UPDATE call_sessions
      SET twilio_call_sid = $2,
          provider = 'twilio',
          provider_status = 'initiated'
      WHERE id = $1
      `,
      [sessionId, callSid]
    );
  }

  if (!toPhoneNumber) {
    twiml.say("Invalid phone number.");
  } else {
    const dial = twiml.dial({
      callerId: process.env.TWILIO_PHONE_NUMBER,
    });

    dial.number(
  {
    statusCallback: `${process.env.PUBLIC_BASE_URL}/api/calls/twilio-status?SessionId=${sessionId}`,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
  },
  toPhoneNumber
);

  }

  res.type("text/xml");
  return res.send(twiml.toString());
}



// ✅ TWILIO STATUS CALLBACK - Call Billing Engine V2
// ✅ TWILIO STATUS CALLBACK
async function twilioStatusCallback(req, res) {
  try {
    console.log("📞 TWILIO CALLBACK =>", req.body);

    const callSid = req.body.CallSid;
    const callStatus = req.body.CallStatus;
    const callDuration = Number(req.body.CallDuration || 0);
    const sessionId = Number(req.query.SessionId || req.body.SessionId || 0);

    if (!callSid && !sessionId) {
      return res.status(200).send("OK");
    }

    // ✅ Receiver answered / call connected
    if (callStatus === "in-progress" || callStatus === "answered") {
      await require("../../config/db").query(
        `
        UPDATE call_sessions
        SET answered_at = COALESCE(answered_at, NOW()),
            provider_status = 'in-progress',
            status_callback_payload = $3
        WHERE twilio_call_sid = $1
           OR id = $2
        `,
        [callSid, sessionId, req.body]
      );

      return res.status(200).send("OK");
    }

    // ✅ Call completed → billing
    if (callStatus === "completed") {
      await billCompletedCallBySid({
        callSid,
        durationSec: callDuration,
        rawPayload: req.body,
      });

      return res.status(200).send("OK");
    }

    // ✅ initiated / ringing / busy / failed / no-answer
    await require("../../config/db").query(
      `
      UPDATE call_sessions
      SET provider_status = $3,
          status_callback_payload = $4
      WHERE twilio_call_sid = $1
         OR id = $2
      `,
      [callSid, sessionId, callStatus, req.body]
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
  getVoiceToken,
  twimlResponse,
  getCallStatus,
};