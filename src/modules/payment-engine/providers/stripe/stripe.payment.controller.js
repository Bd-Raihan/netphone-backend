
"use strict";

const {
  createStripeOrder,
  claimStripeOrderCreation,
  linkStripePaymentIntent,
  getStripeOrderById,
  reconcileStripeOrder,
} = require("./stripe.order.service");

const {
  createStripePaymentIntent,
} = require("./stripe.service");

function authenticatedUserId(req) {
  const id = Number(req.user?.id);

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("invalid_user_id");
  }

  return id;
}

function validOrderId(value) {
  if (!/^[1-9]\d*$/.test(String(value))) {
    throw new Error("invalid_stripe_order_id");
  }

  const id = Number(value);

  if (!Number.isSafeInteger(id)) {
    throw new Error("invalid_stripe_order_id");
  }

  return id;
}

function sendError(res, error) {
  const message = error?.message || "stripe_payment_error";

  const badRequest = [
    "invalid_user_id",
    "invalid_stripe_order_id",
    "invalid_recharge_amount_usd",
    "invalid_stripe_amount",
  ];

  const status = badRequest.includes(message) ||
    message.startsWith("recharge_amount_must_be_between")
      ? 400
      : message === "stripe_order_not_found"
        ? 404
        : 503;

  console.error("Stripe payment error:", message);

  return res.status(status).json({
    ok: false,
    error: status === 503
      ? "stripe_payment_temporarily_unavailable"
      : message,
  });
}


async function createPayment(req, res) {
  let order = null;

  try {
    const userId = authenticatedUserId(req);
    const { amountUsd, clientRequestId } = req.body || {};

    order = await createStripeOrder({
      userId,
      amountUsd,
      clientRequestId,
    });

    const orderId = Number(order.id);

    // Same request: reuse the existing order.
    if (order.isExisting) {
      const recovery = await reconcileStripeOrder({
        orderId,
        userId,
      });

      const latest = await getStripeOrderById(orderId);

      const result = {
        ok: true,
        orderId,
        orderReference: latest.order_reference,
        amountCents: Number(latest.amount_cents),
        currency: latest.currency,
        status: latest.status,
        paymentStatus: recovery.paymentStatus || null,
        requiresReconciliation:
          recovery.requiresReconciliation === true,
        reused: true,
      };

      if (latest.status === "awaiting_payment" &&
          latest.stripe_payment_intent_id) {
        const Stripe = require("stripe");
        const stripe = new Stripe(
          process.env.STRIPE_SECRET_KEY
        );

        const intent = await stripe.paymentIntents.retrieve(
          latest.stripe_payment_intent_id
        );

        if (
          intent.id !== latest.stripe_payment_intent_id ||
          intent.metadata?.order_reference !==
            latest.order_reference ||
          intent.amount !== Number(latest.amount_cents) ||
          intent.currency !== latest.currency
        ) {
          throw new Error("stripe_recovery_payment_mismatch");
        }

        if (
          [
            "requires_payment_method",
            "requires_confirmation",
            "requires_action",
          ].includes(intent.status) &&
          typeof intent.client_secret === "string"
        ) {
          result.clientSecret = intent.client_secret;
        }

        result.paymentStatus = intent.status;
      }

      return res.json(result);
    }

    const claimed = await claimStripeOrderCreation({
      orderId,
      userId,
    });

    const intent = await createStripePaymentIntent({
      amountCents: Number(claimed.amount_cents),
      orderReference: claimed.order_reference,
    });

    if (
      !intent?.id ||
      intent.amount !== Number(claimed.amount_cents) ||
      intent.currency !== "usd" ||
      intent.metadata?.order_reference !==
        claimed.order_reference ||
      typeof intent.client_secret !== "string"
    ) {
      throw new Error("stripe_created_intent_mismatch");
    }

    await linkStripePaymentIntent({
      orderId,
      paymentIntentId: intent.id,
    });

    return res.status(201).json({
      ok: true,
      orderId,
      orderReference: claimed.order_reference,
      amountCents: Number(claimed.amount_cents),
      currency: "usd",
      clientSecret: intent.client_secret,
      paymentStatus: intent.status,
      reused: false,
    });
  } catch (error) {
    if (order) {
      console.error(
        "Stripe order needs review:",
        order.order_reference
      );
    }

    return sendError(res, error);
  }
}


async function getPaymentStatus(req, res) {
  try {
    const userId = authenticatedUserId(req);
    const orderId = validOrderId(req.params.orderId);
    const order = await getStripeOrderById(orderId);

    if (!order || String(order.user_id) !== String(userId)) {
      throw new Error("stripe_order_not_found");
    }

    if (
      ["created", "creating_intent", "awaiting_payment"]
        .includes(order.status)
    ) {
      const recovery = await reconcileStripeOrder({
        orderId,
        userId,
      });

      const currentOrder = await getStripeOrderById(orderId);

      const result = {
        ok: true,
        orderId,
        status: currentOrder.status,
        paymentStatus: recovery.paymentStatus || null,
        requiresReconciliation:
          recovery.requiresReconciliation === true,
      };

      if (
        currentOrder.stripe_payment_intent_id &&
        currentOrder.status === "awaiting_payment"
      ) {
        const Stripe = require("stripe");

        if (!process.env.STRIPE_SECRET_KEY) {
          throw new Error("stripe_secret_key_missing");
        }

        const stripe = new Stripe(
          process.env.STRIPE_SECRET_KEY
        );

        const intent = await stripe.paymentIntents.retrieve(
          currentOrder.stripe_payment_intent_id
        );

        if (
          intent.id !== currentOrder.stripe_payment_intent_id ||
          intent.metadata?.order_reference !==
            currentOrder.order_reference ||
          intent.amount !== Number(currentOrder.amount_cents) ||
          intent.currency !== currentOrder.currency
        ) {
          throw new Error("stripe_recovery_payment_mismatch");
        }

        result.paymentStatus = intent.status;

        if (
          [
            "requires_payment_method",
            "requires_confirmation",
            "requires_action",
          ].includes(intent.status) &&
          typeof intent.client_secret === "string"
        ) {
          result.clientSecret = intent.client_secret;
        }
      }

      return res.json(result);
    }

    return res.json({
      ok: true,
      orderId,
      status: order.status,
      requiresReconciliation: false,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

module.exports = {
  createPayment,
  getPaymentStatus,
};
