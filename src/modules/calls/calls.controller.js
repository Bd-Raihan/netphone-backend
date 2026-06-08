
// ✅ calls.controller.js
const {
  startCallSession,
  endCallAndCharge,
} = require("./calls.service");

// ✅ Twilio Voice API
const { makeCall } = require("./twilio.service");

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

    const twilioResult =
      await makeCall({
      to: to_phone_e164,
      sessionId: result.session.id,
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
async function testCall(req, res) {
  try {
    const result = await makeCall({
      to: "+96598598703",
    });

    return res.json(result);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
}

// ✅ TWILIO STATUS CALLBACK
async function twilioStatusCallback(req, res) {
  try {

    console.log("📞 TWILIO CALLBACK =>", req.body);

    return res.status(200).send("OK");

  } catch (e) {

    console.error("❌ TWILIO CALLBACK ERROR:", e);

    return res.status(500).send("ERROR");
  }
}


module.exports = {
  startCall,
  endCall,
  testCall,
  twilioStatusCallback,
};