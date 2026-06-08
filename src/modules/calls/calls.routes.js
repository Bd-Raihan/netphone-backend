
// ✅ calls.routes.js
const express = require("express");

// controllers
const {startCall, endCall, testCall, twilioStatusCallback,} = require("./calls.controller");
// middlewares
const { authRequired } = require("../auth/middlewares/auth.jwt");
// ✅ PROTECTED ROUTES
const router = express.Router();

// ✅ TEST CALL
router.get("/test", testCall);
// Protected: user must be logged-in
router.post("/start", authRequired, startCall);
// ✅ END CALL
router.post("/:id/end", authRequired, endCall);
// ✅ TWILIO STATUS CALLBACK
router.post("/twilio-status", twilioStatusCallback);

// ✅ PUBLIC ROUTES
module.exports = router;
