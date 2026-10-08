"use strict";

const { verifyTelnyxSignature } = require("./sms.signature");
const service = require("./sms.service");

async function receive(req, res, next) {
  try {
    if (!verifyTelnyxSignature(req)) {
      return res.status(401).json({
        ok: false,
        message: "Invalid webhook signature"
      });
    }

    const event = req.body?.data;

    if (event?.event_type !== "message.received") {
      return res.status(200).json({ ok: true });
    }

    const payload = event.payload || {};

    const id = payload.id;
    const from = payload.from?.phone_number;
    const to = payload.to?.[0]?.phone_number;
    const body = payload.text;

    if (
      typeof id !== "string" ||
      typeof from !== "string" ||
      typeof to !== "string" ||
      typeof body !== "string"
    ) {
      return res.status(400).json({
        ok: false,
        message: "Invalid SMS payload"
      });
    }

    if (body.length > 5000) {
      return res.status(400).json({
        ok: false,
        message: "SMS too large"
      });
    }

    await service.saveInboundSms({ id, from, to, body });

    return res.status(200).json({ ok: true });
  } catch (error) {
    next(error);
  }
}

module.exports = { receive };