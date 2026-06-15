const twilio = require("twilio");
const db = require("../../config/db");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ✅ OTP SMS Send
async function sendOtpSms({ to, code, expiresMin }) {
  try {
    const messageBody = `Your NetPhone OTP is ${code}. It will expire in ${expiresMin} minutes. Do not share this code.`;

    const payload = {
      to,
      body: messageBody,
    };

    if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
      payload.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
    } else {
      payload.from = process.env.TWILIO_PHONE_NUMBER;
    }

    const msg = await client.messages.create(payload);

    return {
      ok: true,
      sid: msg.sid,
      status: msg.status,
    };
  } catch (err) {
    console.error("Twilio SMS Error:", err);
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
      url: "https://demo.twilio.com/docs/voice.xml",
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
};