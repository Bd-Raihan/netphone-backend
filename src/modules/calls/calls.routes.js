/**
 * calls.routes.js
 * ---------------------------------------
 * NetPhone Calling Routes
 * Provider: Telnyx
 */

const express = require("express");
const router = express.Router();

// Controllers
const {
  startCall,
  startTelnyxOutboundCall,
  endCall,
  testCall,
  telnyxStatusCallback,
  getCallStatus,
} = require("./calls.controller");

// Middleware
const { authRequired } = require("../auth/middlewares/auth.jwt");

/*--------------------------------------------------
 | TEST
 *-------------------------------------------------*/

// Production-এ disabled
router.get("/test", testCall);

/*--------------------------------------------------
 | USER CALL API
 *-------------------------------------------------*/

// Call session তৈরি
router.post("/start", authRequired, startCall);

// Telnyx outbound test call
router.post(
  "/telnyx/start",
  authRequired,
  startTelnyxOutboundCall
);

// Call status
router.get(
  "/:id/status",
  authRequired,
  getCallStatus
);

// End call
router.post(
  "/:id/end",
  authRequired,
  endCall
);

/*--------------------------------------------------
 | TELNYX WEBHOOK
 *-------------------------------------------------*/

// Public webhook
router.post(
  "/telnyx-events",
  telnyxStatusCallback
);

module.exports = router;