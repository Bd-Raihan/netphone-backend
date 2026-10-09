"use strict";

const MIN_RECHARGE_CENTS = 500;
const MAX_RECHARGE_CENTS = 50000;
const MICRO_USD_PER_CENT = 10000;

function normalizeRechargeCents(amountUsd) {
  if (
    typeof amountUsd !== "number" &&
    typeof amountUsd !== "string"
  ) {
    throw new Error("invalid_recharge_amount");
  }

  const value = String(amountUsd).trim();

  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new Error("invalid_recharge_amount");
  }

  const [whole, fraction = ""] = value.split(".");

  const cents =
    Number(whole) * 100 +
    Number(fraction.padEnd(2, "0"));

  if (
    !Number.isSafeInteger(cents) ||
    cents < MIN_RECHARGE_CENTS ||
    cents > MAX_RECHARGE_CENTS
  ) {
    throw new Error(
      "recharge_amount_must_be_between_5_and_500_usd"
    );
  }

  return cents;
}

function centsToMicroUsd(cents) {
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error("invalid_amount_cents");
  }

  return cents * MICRO_USD_PER_CENT;
}

module.exports = {
  normalizeRechargeCents,
  centsToMicroUsd,
};
