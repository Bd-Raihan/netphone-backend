"use strict";

/**
 * NetPhone Payment Engine constants
 *
 * Current providers only:
 * - Manual Crypto
 * - Binance On-chain
 * - Binance Pay
 *
 * Future payment providers এখানে এখন যোগ করা হবে না।
 */

const PAYMENT_PROVIDERS = Object.freeze({
  MANUAL_CRYPTO: "manual_crypto",
  BINANCE_ONCHAIN: "binance_onchain",
  BINANCE_PAY: "binance_pay",
});

const PAYMENT_TYPES = Object.freeze({
  CRYPTO_RECHARGE: "crypto_recharge",
});

const PAYMENT_STATUSES = Object.freeze({
  CREATED: "created",
  AWAITING_PAYMENT: "awaiting_payment",
  PAYMENT_DETECTED: "payment_detected",
  CONFIRMING: "confirming",
  PAID: "paid",
  CREDITED: "credited",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
  FAILED: "failed",
  MANUAL_REVIEW: "manual_review",
  REJECTED: "rejected",
});

const CRYPTO_HISTORY_EVENT_TYPES = Object.freeze({
  ORDER_CREATED: "order_created",
  AWAITING_PAYMENT: "awaiting_payment",
  TX_SUBMITTED: "tx_submitted",
  DEPOSIT_DETECTED: "deposit_detected",
  CONFIRMATION_UPDATED: "confirmation_updated",
  VERIFICATION_PASSED: "verification_passed",
  VERIFICATION_FAILED: "verification_failed",
  PAYMENT_PAID: "payment_paid",
  WALLET_CREDITED: "wallet_credited",
  MANUAL_REVIEW: "manual_review",
  APPROVED: "approved",
  REJECTED: "rejected",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
  FAILED: "failed",
});

const VERIFICATION_RESULTS = Object.freeze({
  PENDING: "pending",
  PASSED: "passed",
  FAILED: "failed",
  MANUAL_REVIEW: "manual_review",
});

const WALLET_TRANSACTION_TYPES = Object.freeze({
  RECHARGE: "recharge",
});

const MICRO_USD_PER_USD = 1_000_000;

const SUPPORTED_CRYPTO_ASSETS = Object.freeze({
  USDT: "USDT",
  BTC: "BTC",
  LTC: "LTC",
});

const SUPPORTED_CRYPTO_NETWORKS = Object.freeze({
  TRC20: "TRC20",
  BEP20: "BEP20",
  BTC: "BTC",
  LTC: "LTC",
});

const ACTIVE_PROVIDER_VALUES = Object.freeze(
  Object.values(PAYMENT_PROVIDERS)
);

const ACTIVE_PAYMENT_STATUS_VALUES = Object.freeze(
  Object.values(PAYMENT_STATUSES)
);

const ACTIVE_HISTORY_EVENT_VALUES = Object.freeze(
  Object.values(CRYPTO_HISTORY_EVENT_TYPES)
);

function isSupportedProvider(value) {
  return ACTIVE_PROVIDER_VALUES.includes(value);
}

function isSupportedPaymentStatus(value) {
  return ACTIVE_PAYMENT_STATUS_VALUES.includes(value);
}

function isSupportedHistoryEvent(value) {
  return ACTIVE_HISTORY_EVENT_VALUES.includes(value);
}

function usdToMicroUsd(amountUsd) {
  const normalizedAmount = Number(amountUsd);

  if (
    !Number.isFinite(normalizedAmount) ||
    normalizedAmount <= 0
  ) {
    throw new Error("invalid_usd_amount");
  }

  const amountMicroUsd = Math.round(
    normalizedAmount * MICRO_USD_PER_USD
  );

  if (
    !Number.isSafeInteger(amountMicroUsd) ||
    amountMicroUsd <= 0
  ) {
    throw new Error("invalid_microusd_amount");
  }

  return amountMicroUsd;
}

function microUsdToUsd(amountMicroUsd) {
  const normalizedAmount = Number(amountMicroUsd);

  if (
    !Number.isSafeInteger(normalizedAmount) ||
    normalizedAmount < 0
  ) {
    throw new Error("invalid_microusd_amount");
  }

  return normalizedAmount / MICRO_USD_PER_USD;
}

module.exports = {
  PAYMENT_PROVIDERS,
  PAYMENT_TYPES,
  PAYMENT_STATUSES,
  CRYPTO_HISTORY_EVENT_TYPES,
  VERIFICATION_RESULTS,
  WALLET_TRANSACTION_TYPES,
  MICRO_USD_PER_USD,
  SUPPORTED_CRYPTO_ASSETS,
  SUPPORTED_CRYPTO_NETWORKS,
  ACTIVE_PROVIDER_VALUES,
  ACTIVE_PAYMENT_STATUS_VALUES,
  ACTIVE_HISTORY_EVENT_VALUES,
  isSupportedProvider,
  isSupportedPaymentStatus,
  isSupportedHistoryEvent,
  usdToMicroUsd,
  microUsdToUsd,
};