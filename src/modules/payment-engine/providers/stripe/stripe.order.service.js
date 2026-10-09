
"use strict";

const crypto = require("crypto");
const db = require("../../../../config/db");
const { normalizeRechargeCents, centsToMicroUsd } =
  require("./stripe.amount");


async function createStripeOrder({
  userId,
  amountUsd,
  clientRequestId,
}) {
  const id = Number(userId);

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("invalid_user_id");
  }

  if (
    typeof clientRequestId !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(clientRequestId) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(clientRequestId)
  ) {
    throw new Error("invalid_client_request_id");
  }

  const amountCents = normalizeRechargeCents(amountUsd);
  const amountMicroUsd = centsToMicroUsd(amountCents);

  const orderReference =
    `st_${crypto.randomUUID().replace(/-/g, "")}`;

  const { rows } = await db.query(
    `
      INSERT INTO stripe_payment_orders (
        order_reference,
        user_id,
        amount_cents,
        amount_microusd,
        currency,
        status,
        client_request_id
      )
      VALUES ($1, $2, $3, $4, 'usd', 'created', $5)

      ON CONFLICT (user_id, client_request_id)
      WHERE client_request_id IS NOT NULL
      DO NOTHING

      RETURNING
        id,
        order_reference,
        amount_cents,
        currency,
        status,
        client_request_id
    `,
    [
      orderReference,
      id,
      amountCents,
      amountMicroUsd,
      clientRequestId,
    ]
  );

  if (rows[0]) {
    return {
      ...rows[0],
      isExisting: false,
    };
  }

  const existing = await db.query(
    `
      SELECT
        id,
        order_reference,
        amount_cents,
        currency,
        status,
        client_request_id
      FROM stripe_payment_orders
      WHERE user_id = $1
        AND client_request_id = $2
      LIMIT 1
    `,
    [id, clientRequestId]
  );

  const order = existing.rows[0];

  if (!order) {
    throw new Error("stripe_request_conflict");
  }

  if (
    Number(order.amount_cents) !== amountCents ||
    order.currency !== "usd"
  ) {
    throw new Error("stripe_request_amount_mismatch");
  }

  return {
    ...order,
    isExisting: true,
  };
}




async function linkStripePaymentIntent({
  orderId,
  paymentIntentId,
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

  const { rows } = await db.query(
    `
      UPDATE stripe_payment_orders
      SET
        stripe_payment_intent_id = $2,
        status = 'awaiting_payment',
        updated_at = NOW()
      WHERE id = $1
        AND status = 'creating_intent'
        AND stripe_payment_intent_id IS NULL
      RETURNING id, order_reference, status,
                stripe_payment_intent_id
    `,
    [orderId, paymentIntentId]
  );

  if (rows[0]) return rows[0];

  const existing = await getStripeOrderById(orderId);

  if (
    existing &&
    existing.stripe_payment_intent_id === paymentIntentId &&
    ["awaiting_payment", "paid", "credited"].includes(existing.status)
  ) {
    return existing;
  }

  throw new Error("stripe_order_link_conflict");
}



async function getStripeOrderById(orderId) {
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    throw new Error("invalid_stripe_order_id");
  }

  const { rows } = await db.query(
    `
      SELECT
        id,
        order_reference,
        user_id,
        amount_cents,
        currency,
        stripe_payment_intent_id,
        status
      FROM stripe_payment_orders
      WHERE id = $1
      LIMIT 1
    `,
    [orderId]
  );

  return rows[0] || null;
}



async function recoverStripePaymentIntent({
  orderId,
  userId,
}) {
  const order = await getStripeOrderById(orderId);

  if (!order || String(order.user_id) !== String(userId)) {
    throw new Error("stripe_order_not_found");
  }

  if (!["created", "creating_intent", "awaiting_payment"].includes(order.status)) {
    throw new Error("stripe_order_not_recoverable");
  }

 if (!order.stripe_payment_intent_id) {
  return {
    order,
    needsCreation: false,
    requiresReconciliation: true,
  };
}

  const Stripe = require("stripe");

  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("stripe_secret_key_missing");
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const intent = await stripe.paymentIntents.retrieve(
    order.stripe_payment_intent_id
  );

  if (
    intent.id !== order.stripe_payment_intent_id ||
    intent.metadata?.order_reference !== order.order_reference ||
    intent.amount !== Number(order.amount_cents) ||
    intent.currency !== order.currency
  ) {
    throw new Error("stripe_recovery_payment_mismatch");
  }

  return {
    order,
    needsCreation: false,
    paymentIntentId: intent.id,
    paymentStatus: intent.status,
  };
}



async function reconcileStripeOrder({ orderId, userId }) {
  const order = await getStripeOrderById(orderId);

  if (!order || String(order.user_id) !== String(userId)) {
    throw new Error("stripe_order_not_found");
  }

  if (order.stripe_payment_intent_id) {
    return recoverStripePaymentIntent({ orderId, userId });
  }

  const { findStripePaymentIntentByReference } =
    require("./stripe.service");

  const intent = await findStripePaymentIntentByReference(
    order.order_reference
  );

  if (!intent) {
    return {
      order,
      requiresReconciliation: true,
      reason: "stripe_payment_intent_not_found",
    };
  }

  if (
    intent.metadata?.order_reference !== order.order_reference ||
    intent.amount !== Number(order.amount_cents) ||
    intent.currency !== order.currency
  ) {
    throw new Error("stripe_reconciliation_mismatch");
  }

  await linkStripePaymentIntent({
    orderId,
    paymentIntentId: intent.id,
  });

  return recoverStripePaymentIntent({ orderId, userId });
}



async function lockStripeOrderForCreation(client, orderId) {
  if (!client || typeof client.query !== "function") {
    throw new Error("database_client_required");
  }

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

async function claimStripeOrderCreation({ orderId, userId }) {
  const id = Number(orderId);
  const uid = Number(userId);

  if (!Number.isSafeInteger(id) || id <= 0 ||
      !Number.isSafeInteger(uid) || uid <= 0) {
    throw new Error("invalid_stripe_order_or_user_id");
  }

  const { rows } = await db.query(
    `
      UPDATE stripe_payment_orders
      SET status = 'creating_intent',
          creation_started_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
        AND user_id = $2
        AND status = 'created'
        AND stripe_payment_intent_id IS NULL
      RETURNING id, order_reference, amount_cents, currency, status
    `,
    [id, uid]
  );

  if (!rows[0]) {
    throw new Error("stripe_order_creation_not_available");
  }

  return rows[0];
}

module.exports = { 
    createStripeOrder, 
    linkStripePaymentIntent,
    getStripeOrderById,
    recoverStripePaymentIntent,
    reconcileStripeOrder,
    lockStripeOrderForCreation,
    claimStripeOrderCreation,
};
