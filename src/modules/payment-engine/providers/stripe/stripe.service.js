
"use strict";

const {
  normalizeRechargeCents,
  centsToMicroUsd,
} = require("./stripe.amount");

function preparePaymentIntent({
  amountUsd,
  orderReference,
}) {
  const amountCents =
    normalizeRechargeCents(amountUsd);

  if (
    typeof orderReference !== "string" ||
    !/^[A-Za-z0-9_-]{8,80}$/.test(orderReference)
  ) {
    throw new Error("invalid_order_reference");
  }

  return {
    amount: amountCents,
    currency: "usd",
    amountMicroUsd:
      centsToMicroUsd(amountCents),
    orderReference,
  };
}


async function createStripePaymentIntent({
  amountCents,
  orderReference,
}) {
  const Stripe = require("stripe");

  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents < 500 ||
    amountCents > 50000
  ) {
    throw new Error("invalid_stripe_amount");
  }

  if (
    typeof orderReference !== "string" ||
    !/^[A-Za-z0-9_-]{8,80}$/.test(orderReference)
  ) {
    throw new Error("invalid_order_reference");
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("stripe_secret_key_missing");
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  return stripe.paymentIntents.create(
    {
      amount: amountCents,
      currency: "usd",
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        order_reference: orderReference,
      },
    },
    {
      idempotencyKey: `netphone_stripe_${orderReference}`,
    }
  );
}


async function findStripePaymentIntentByReference(orderReference) {
  if (
    typeof orderReference !== "string" ||
    !/^[A-Za-z0-9_-]{8,80}$/.test(orderReference)
  ) {
    throw new Error("invalid_order_reference");
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("stripe_secret_key_missing");
  }

  const Stripe = require("stripe");
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const result = await stripe.paymentIntents.search({
    query: `metadata['order_reference']:'${orderReference}'`,
    limit: 10,
  });

  if (result.has_more || result.data.length > 1) {
    throw new Error("stripe_order_requires_manual_review");
  }

  return result.data[0] || null;
}



module.exports = {
  preparePaymentIntent,
  createStripePaymentIntent,
  findStripePaymentIntentByReference,
};
