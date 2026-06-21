
// ✅ calls.routes.js
const express = require("express");



// controllers
const {
  startCall,
  endCall,
  testCall,
  twilioStatusCallback,
  getVoiceToken,
  twimlResponse,
  getCallStatus,
} = require("./calls.controller");
// middlewares
const { authRequired } = require("../auth/middlewares/auth.jwt");
// ✅ PROTECTED ROUTES
const router = express.Router();

// ✅ TEST CALL
router.get("/test", testCall);

// Twilio voice instruction XML
router.get("/twiml", twimlResponse);

// Protected: user must be logged-in
router.post("/start", authRequired, startCall);

// Protected: user must be logged-in
router.get("/token", authRequired, getVoiceToken);

// ✅ Get call status by session id
router.get("/:id/status", authRequired, getCallStatus);

// ✅ END CALL
router.post("/:id/end", authRequired, endCall);
// ✅ TWILIO STATUS CALLBACK
router.post("/twilio-status", twilioStatusCallback);

// Twilio voice instruction XML
router.post("/twiml", twimlResponse);

// ✅ PUBLIC ROUTES
module.exports = router;
