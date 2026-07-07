const twilio = require("twilio");
const db = require("../../config/db");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ✅ OTP SMS Send
async function sendOtpSms({ to }) {
  try {
    const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

    if (!serviceSid) {
      throw new Error("TWILIO_VERIFY_SERVICE_SID missing");
    }

    const verification = await client.verify.v2
      .services(serviceSid)
      .verifications.create({
        to,
        channel: "sms",
      });

    return {
      ok: true,
      sid: verification.sid,
      status: verification.status,
    };
  } catch (err) {
    console.error("Twilio Verify Send Error:", err);
    return {
      ok: false,
      error: err.message,
    };
  }
}

async function checkOtpVerify({ to, code }) {
  try {
    const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

    if (!serviceSid) {
      throw new Error("TWILIO_VERIFY_SERVICE_SID missing");
    }

    const result = await client.verify.v2
      .services(serviceSid)
      .verificationChecks.create({
        to,
        code,
      });

    return {
      ok: result.status === "approved",
      status: result.status,
    };
  } catch (err) {
    console.error("Twilio Verify Check Error:", err);
    return {
      ok: false,
      error: err.message,
    };
  }
}

// ✅ Real Call
async function makeCall({ to, sessionId }) {
  try {
    const call = await client.calls.create({
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${process.env.PUBLIC_BASE_URL}/api/calls/twiml`,
      statusCallback: `${process.env.PUBLIC_BASE_URL}/api/calls/twilio-status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
    });

    await db.query(
      `UPDATE call_sessions
       SET twilio_call_sid = $2,
           provider = 'twilio'
       WHERE id = $1`,
      [sessionId, call.sid]
    );

    return {
      ok: true,
      sid: call.sid,
      status: call.status,
    };
  } catch (err) {
    console.error("Twilio Call Error:", err);
    return {
      ok: false,
      error: err.message,
    };
  }
}


module.exports = {
  makeCall,
  sendOtpSms,
  checkOtpVerify,
};