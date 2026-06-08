const { z } = require("zod");

/// 🛠️ List transactions schema
const listTxSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// 🛠️ Admin wallet adjust schema
const adminAdjustSchema = z.object({
  user_id: z.coerce.number().int().positive(),
  currency: z.string().min(3).max(3).default("USD"),
  amount_cents: z.coerce.number().int(), // +credit, -debit
  idempotency_key: z.string().min(6).max(80).optional(),
  meta: z.any().optional(),
});

/// 🛠️ Validation wrapper
module.exports = {
  listTxSchema,
  adminAdjustSchema,
};
