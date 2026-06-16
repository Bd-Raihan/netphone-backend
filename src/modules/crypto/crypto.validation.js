/// ==========================================================
/// crypto.validation.js
/// Production Grade Validation
///
/// কাজ:
/// - Crypto Recharge Request Validate
/// - Admin Approve Validate
/// - Admin Reject Validate
/// ==========================================================

const Joi = require("joi");

/// ==========================================================
/// User Recharge Request
/// ==========================================================
const rechargeRequestSchema = Joi.object({
  amount_usd: Joi.number()
    .positive()
    .max(100000)
    .precision(2)
    .required(),

  crypto_currency: Joi.string()
    .valid("USDT")
    .default("USDT"),

  network: Joi.string()
    .valid("TRC20")
    .default("TRC20"),

  tx_hash: Joi.string()
    .trim()
    .min(20)
    .max(200)
    .required(),

  wallet_address: Joi.string()
    .trim()
    .min(20)
    .max(100)
    .allow("")
    .optional()
});

/// ==========================================================
/// Admin Approve
/// ==========================================================
const approveRechargeSchema = Joi.object({

  admin_note: Joi.string()
    .trim()
    .max(500)
    .allow("")
    .optional()

});

/// ==========================================================
/// Admin Reject
/// ==========================================================
const rejectRechargeSchema = Joi.object({

  admin_note: Joi.string()
    .trim()
    .min(3)
    .max(500)
    .required()

});

module.exports = {

  rechargeRequestSchema,

  approveRechargeSchema,

  rejectRechargeSchema

};