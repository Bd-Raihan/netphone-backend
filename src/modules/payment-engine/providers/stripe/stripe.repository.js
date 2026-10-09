
"use strict";

const db = require("../../../../config/db");

function assertClient(client) {
  if (!client || typeof client.query !== "function") {
    throw new Error("database_client_required");
  }
}

async function getOrderForUpdate(client, orderId) {
  assertClient(client);

  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    throw new Error("invalid_stripe_order_id");
  }

  const { rows } = await client.query(
    `
      SELECT *
      FROM stripe_payment_orders
      WHERE id = $1
      FOR UPDATE
    `,
    [orderId]
  );

  return rows[0] || null;
}

async function getOrderByReference(orderReference) {
  if (
    typeof orderReference !== "string" ||
    !/^[A-Za-z0-9_-]{8,80}$/.test(orderReference)
  ) {
    throw new Error("invalid_order_reference");
  }

  const { rows } = await db.query(
    `
      SELECT *
      FROM stripe_payment_orders
      WHERE order_reference = $1
      LIMIT 1
    `,
    [orderReference]
  );

  return rows[0] || null;
}



async function creditVerifiedStripeOrder({
  orderId,
  paymentIntentId,
  amountCents,
  currency,
}) {
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    throw new Error("invalid_stripe_order_id");
  }

  if (
    typeof paymentIntentId !== "string" ||
    !/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)
  ) {
    throw new Error("invalid_payment_intent_id");
  }

  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error("invalid_payment_amount");
  }

  if (currency !== "usd") {
    throw new Error("invalid_payment_currency");
  }

  const { applyWalletTxWithClient } =
    require("../../../wallet/wallet.service");

  const client = await db.getClient();

  try {
    await client.query("BEGIN");

    const order = await getOrderForUpdate(client, orderId);

    if (!order) throw new Error("stripe_order_not_found");

    if (order.status === "credited") {
      if (
        order.stripe_payment_intent_id !== paymentIntentId ||
        Number(order.amount_cents) !== amountCents ||
        Number(order.amount_microusd) !== amountCents * 10000 ||
        order.currency !== currency ||
        !order.wallet_tx_id ||
        !order.credited_at
      ) {
        throw new Error("payment_intent_mismatch");
      }

      await client.query("COMMIT");
      return { ok: true, duplicated: true };
    }

    if (
      !["created", "awaiting_payment", "paid"].includes(order.status)
    ) {
      throw new Error("stripe_order_not_creditable");
    }

    if (
      order.stripe_payment_intent_id !== paymentIntentId ||
      Number(order.amount_cents) !== amountCents ||
      Number(order.amount_microusd) !== amountCents * 10000 ||
      order.currency !== currency
    ) {
      throw new Error("stripe_payment_mismatch");
    }

    const result = await applyWalletTxWithClient({
      client,
      userId: order.user_id,
      amountCents,
      amountMicroUsd: amountCents * 10000,
      txType: "recharge",
      idempotencyKey: `stripe:${paymentIntentId}`,
      reference: order.order_reference,
      meta: {
        provider: "stripe",
        stripe_payment_intent_id: paymentIntentId,
        stripe_order_id: order.id,
      },
    });

    if (!result.ok) {
      throw new Error("stripe_wallet_credit_failed");
    }

    if (result.duplicated) {
      throw new Error("stripe_duplicate_ledger_requires_review");
    }

    await client.query(
      `
        UPDATE stripe_payment_orders
        SET status = 'credited',
            wallet_tx_id = $2,
            credited_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
      [order.id, result.tx.id]
    );

    await client.query("COMMIT");

    return { ok: true, duplicated: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}


module.exports = {
  getOrderForUpdate,
  getOrderByReference,
  creditVerifiedStripeOrder,
};
