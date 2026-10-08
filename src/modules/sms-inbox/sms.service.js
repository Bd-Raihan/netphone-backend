"use strict";

const { query } = require("../../config/db");

async function saveInboundSms(data) {
  const result = await query(
    `INSERT INTO netphone_inbound_sms
      (telnyx_message_id, from_number, to_number, message_body)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telnyx_message_id) DO NOTHING
     RETURNING id`,
    [data.id, data.from, data.to, data.body]
  );

  return result.rows[0] || null;
}

async function listInboundSms() {
  const result = await query(
    `SELECT id, from_number, to_number, message_body, received_at
     FROM netphone_inbound_sms
     WHERE expires_at > NOW()
     ORDER BY received_at DESC
     LIMIT 50`
  );

  return result.rows;
}

async function deleteExpiredSms() {
  const result = await query(
    `DELETE FROM netphone_inbound_sms
     WHERE expires_at <= NOW()`
  );

  return result.rowCount;
}

module.exports = {
  saveInboundSms,
  listInboundSms,
  deleteExpiredSms
};