
"use strict";

const Stripe = require("stripe");
const { verifyStripePaymentIntent } = require("./stripe.verify");
const {
  getOrderByReference,
  creditVerifiedStripeOrder,
} = require("./stripe.repository");

async function handleStripeWebhook(req, res) {
  const signature = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !secret || !Buffer.isBuffer(req.rawBody)) {
    return res.status(400).json({
      ok: false,
      error: "invalid_stripe_webhook_request",
    });
  }

  let event;

  try {
    event = Stripe.webhooks.constructEvent(
      req.rawBody,
      signature,
      secret
    );
  } catch (_) {
    return res.status(400).json({
      ok: false,
      error: "invalid_stripe_signature",
    });
  }

  if (event.type !== "payment_intent.succeeded") {
    return res.status(200).json({
      ok: true,
      ignored: true,
    });
  }

  try {
    const intentId = event.data.object.id;

    const verified = await verifyStripePaymentIntent(intentId);

    const orderReference =
      event.data.object.metadata?.order_reference;

    if (
      typeof orderReference !== "string" ||
      !/^st_[a-f0-9]{32}$/.test(orderReference)
    ) {
      throw new Error("stripe_order_reference_invalid");
    }

    const order = await getOrderByReference(orderReference);

    if (!order) {
      throw new Error("stripe_order_not_found");
    }

    if (
      order.stripe_payment_intent_id !== verified.paymentIntentId ||
      Number(order.amount_cents) !== verified.amountCents ||
      order.currency !== verified.currency
    ) {
      throw new Error("stripe_payment_order_mismatch");
    }

    const result = await creditVerifiedStripeOrder({
      orderId: Number(order.id),
      paymentIntentId: verified.paymentIntentId,
      amountCents: verified.amountCents,
      currency: verified.currency,
    });

    return res.status(200).json({
      ok: true,
      credited: true,
      duplicated: result.duplicated,
    });
  } catch (error) {
    console.error("Stripe webhook processing failed:", error.message);

    return res.status(500).json({
      ok: false,
      error: "stripe_webhook_processing_failed",
    });
  }
}

module.exports = { handleStripeWebhook };
