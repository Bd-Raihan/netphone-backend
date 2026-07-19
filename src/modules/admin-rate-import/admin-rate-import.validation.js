/**
 * admin-rate-import.validation.js
 * --------------------------------------------------
 * Admin Provider Rate Import API Validation
 *
 * এই file-এর কাজ:
 * 1. Provider code validate করা
 * 2. Provider plan code validate করা
 * 3. CSV filename validate করা
 * 4. Path traversal attack আটকানো
 * 5. Batch size-এর নিরাপদ সীমা নিশ্চিত করা
 */

const { z } = require("zod");

/**
 * Provider ও plan code:
 * - lowercase letter দিয়ে শুরু
 * - lowercase letter, number, underscore এবং hyphen গ্রহণযোগ্য
 */
const providerCodeSchema = z
  .string({
    required_error: "provider is required",
    invalid_type_error: "provider must be a string",
  })
  .trim()
  .min(1, "provider is required")
  .max(50, "provider is too long")
  .regex(
    /^[a-z][a-z0-9_-]*$/,
    "provider contains invalid characters"
  );

/**
 * Provider plan code validation।
 *
 * Example:
 * payg
 * starter
 * growth
 * enterprise
 */
const planCodeSchema = z
  .string({
    required_error: "plan is required",
    invalid_type_error: "plan must be a string",
  })
  .trim()
  .min(1, "plan is required")
  .max(50, "plan is too long")
  .regex(
    /^[a-z][a-z0-9_-]*$/,
    "plan contains invalid characters"
  );

/**
 * শুধু plain CSV filename গ্রহণ করা হবে।
 *
 * গ্রহণযোগ্য:
 * telnyx_global_conversational.csv
 *
 * গ্রহণযোগ্য নয়:
 * ../secret.csv
 * folder/file.csv
 * C:\file.csv
 */
const fileNameSchema = z
  .string({
    required_error: "file is required",
    invalid_type_error: "file must be a string",
  })
  .trim()
  .min(1, "file is required")
  .max(255, "file name is too long")
  .refine(
    (value) =>
      !value.includes("/") &&
      !value.includes("\\") &&
      value !== "." &&
      value !== "..",
    {
      message:
        "file must be a plain filename without any folder path",
    }
  )
  .refine(
    (value) =>
      /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.csv$/i.test(
        value
      ),
    {
      message:
        "file must be a valid CSV filename",
    }
  );

/**
 * Rate deck validation/preview request।
 */
const validateRateDeckSchema = z
  .object({
    provider: providerCodeSchema.default("telnyx"),

    file: fileNameSchema,

    sample_limit: z.coerce
      .number()
      .int("sample_limit must be an integer")
      .min(
        0,
        "sample_limit cannot be negative"
      )
      .max(
        100,
        "sample_limit cannot exceed 100"
      )
      .default(10),
  })
  .strict();

/**
 * Actual rate import request।
 */
const importRateDeckSchema = z
  .object({
    provider: providerCodeSchema.default("telnyx"),

    plan: planCodeSchema.default("payg"),

    file: fileNameSchema,

    batch_size: z.coerce
      .number()
      .int("batch_size must be an integer")
      .min(
        100,
        "batch_size must be at least 100"
      )
      .max(
        5000,
        "batch_size cannot exceed 5000"
      )
      .default(500),

    allow_duplicate_checksum: z.coerce
      .boolean()
      .default(false),
  })
  .strict();

/**
 * Zod validation error-কে API-friendly format-এ convert করে।
 */
function formatZodError(error) {
  return error.issues.map((issue) => ({
    field:
      issue.path.length > 0
        ? issue.path.join(".")
        : "request",

    message: issue.message,

    code: issue.code,
  }));
}

/**
 * Validation middleware factory।
 *
 * Valid data req.validatedBody-তে রাখা হবে।
 */
function validateBody(schema) {
  return function validationMiddleware(
    req,
    res,
    next
  ) {
    const result = schema.safeParse(
      req.body || {}
    );

    if (!result.success) {
      return res.status(400).json({
        ok: false,
        message: "Invalid request data",
        errors: formatZodError(
          result.error
        ),
      });
    }

    req.validatedBody = result.data;

    return next();
  };
}

module.exports = {
  validateRateDeckSchema,
  importRateDeckSchema,
  validateBody,
};