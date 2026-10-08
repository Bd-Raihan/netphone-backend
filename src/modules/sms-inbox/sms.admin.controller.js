"use strict";

const service = require("./sms.service");

async function list(req, res, next) {
  try {
    const messages = await service.listInboundSms();

    res.set("Cache-Control", "no-store");

    return res.json({
      ok: true,
      messages
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { list };