/**
 * auth.validation.js
 * কাজ:
 * - ইনপুট validation (OTP request / verify)
 */

const { z } = require("zod");

// ✅ Phone E.164 format basic check: +965xxxxxxxx
const phoneSchema = z
  .string()
  .min(8, "Phone too short")
  .max(20, "Phone too long")
  .regex(/^\+\d{7,19}$/, "Phone must be in E.164 format like +965xxxxxxxx");

const requestOtpSchema = z.object({
  phone_e164: phoneSchema,
});

const verifyOtpSchema = z.object({
  phone_e164: phoneSchema,
  code: z.string().min(4).max(10),
});

module.exports = {
  requestOtpSchema,
  verifyOtpSchema,
};
