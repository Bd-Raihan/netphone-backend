const twilio = require("twilio");
const db = require("../../config/db");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
async function makeCall({ to,sessionId, }) {
  try {
    const call = await client.calls.create({
      to,
      from: process.env.TWILIO_PHONE_NUMBER,

      url: "https://demo.twilio.com/docs/voice.xml"
    });
    
    await db.query(
    `UPDATE call_sessions
    SET
    twilio_call_sid = $2,
    provider = 'twilio'
    WHERE id = $1
    `,
    [
    sessionId, call.sid ]
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
};