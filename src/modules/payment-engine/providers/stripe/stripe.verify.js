
"use strict";

const Stripe = require("stripe");

async function verifyStripePaymentIntent(paymentIntentId) {
  if (
    typeof paymentIntentId !== "string" ||
    !/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)
  ) {
    throw new Error("invalid_payment_intent_id");
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    throw new Error("stripe_secret_key_missing");
  }

  const stripe = new Stripe(secretKey);

  const intent = await stripe.paymentIntents.retrieve(
    paymentIntentId
  );

  if (
    intent.id !== paymentIntentId ||
    intent.status !== "succeeded" ||
    intent.currency !== "usd" ||
    !Number.isSafeInteger(intent.amount_received) ||
    intent.amount_received <= 0
  ) {
    throw new Error("stripe_payment_not_verified");
  }

 return {
  paymentIntentId: intent.id,
  amountCents: intent.amount_received,
  currency: intent.currency,
  status: intent.status,
  livemode: intent.livemode,
};
}

module.exports = { verifyStripePaymentIntent };
