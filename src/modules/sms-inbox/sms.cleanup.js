"use strict";

const service = require("./sms.service");

let cleanupTimer = null;

async function cleanupExpiredSms() {
  try {
    const deleted = await service.deleteExpiredSms();

    if (deleted > 0) {
      console.log(
        `[SMS Inbox] ${deleted} expired messages deleted`
      );
    }

    return deleted;
  } catch (error) {
    console.error(
      "[SMS Inbox] Cleanup failed:",
      error.message
    );

    return 0;
  }
}

function startSmsCleanup() {
  if (cleanupTimer) return;

  // Run cleanup every hour.
  cleanupTimer = setInterval(
    cleanupExpiredSms,
    60 * 60 * 1000
  );

  // Timer will not prevent graceful shutdown.
  cleanupTimer.unref();

  console.log("[SMS Inbox] Cleanup scheduler started");
}

function stopSmsCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

module.exports = {
  cleanupExpiredSms,
  startSmsCleanup,
  stopSmsCleanup
};