"use strict";

const crypto = require("crypto");

const paymentRepository = require("./payment.repository");

const {
  CRYPTO_HISTORY_EVENT_TYPES,
  VERIFICATION_RESULTS,
  isSupportedHistoryEvent,
} = require("./payment.constants");

const SENSITIVE_KEY_PATTERNS = [
  "api_key",
  "apikey",
  "api-key",
  "secret",
  "secret_key",
  "secretkey",
  "signature",
  "authorization",
  "password",
  "token",
  "private_key",
  "privatekey",
  "access_key",
  "accesskey",
];

/**
 * Database raw_payload-এ sensitive information সংরক্ষণ বন্ধ করে।
 */
function isSensitiveKey(key) {
  const normalizedKey = String(key)
    .trim()
    .toLowerCase();

  return SENSITIVE_KEY_PATTERNS.some(
    (pattern) =>
      normalizedKey === pattern ||
      normalizedKey.includes(pattern)
  );
}

/**
 * Provider response recursively sanitize করে।
 */
function sanitizePayload(value, depth = 0) {
  if (depth > 8) {
    return "[MAX_DEPTH_REACHED]";
  }

  if (
    value === null ||
    value === undefined
  ) {
    return value ?? null;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item) =>
        sanitizePayload(item, depth + 1)
      );
  }

  if (typeof value === "object") {
    const sanitized = {};

    const entries = Object.entries(value)
      .slice(0, 200);

    for (const [key, itemValue] of entries) {
      if (isSensitiveKey(key)) {
        sanitized[key] = "[REDACTED]";
        continue;
      }

      sanitized[key] = sanitizePayload(
        itemValue,
        depth + 1
      );
    }

    return sanitized;
  }

  return String(value);
}

/**
 * Event key-এর অংশগুলো normalize করে।
 */
function normalizeEventPart(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "none";
  }

  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

/**
 * একটি deterministic event key তৈরি করে।
 *
 * একই provider event আবার এলে একই key তৈরি হবে,
 * ফলে database unique constraint duplicate insert আটকাবে।
 */
function buildEventKey({
  provider,
  paymentOrderId,
  eventType,
  providerEventId = null,
  txHash = null,
  sequence = null,
}) {
  if (!provider) {
    throw new Error("history_provider_required");
  }

  if (!paymentOrderId) {
    throw new Error(
      "history_payment_order_id_required"
    );
  }

  if (!isSupportedHistoryEvent(eventType)) {
    throw new Error(
      "unsupported_history_event_type"
    );
  }

  const rawKey = [
    normalizeEventPart(provider),
    normalizeEventPart(paymentOrderId),
    normalizeEventPart(eventType),
    normalizeEventPart(providerEventId),
    normalizeEventPart(txHash),
    normalizeEventPart(sequence),
  ].join(":");

  const hash = crypto
    .createHash("sha256")
    .update(rawKey)
    .digest("hex")
    .slice(0, 32);

  return `${normalizeEventPart(provider)}:${normalizeEventPart(
    eventType
  )}:${hash}`;
}

/**
 * Generic crypto history event record।
 */
async function recordCryptoEvent({
  paymentOrderId,
  userId,
  provider,

  eventType,
  eventKey = null,

  providerEventId = null,
  sequence = null,

  orderStatus = null,

  asset = null,
  network = null,

  cryptoAmount = null,
  usdAmount = null,
  amountMicroUsd = null,

  txHash = null,

  providerOrderId = null,
  providerTransactionId = null,

  confirmations = null,
  requiredConfirmations = null,

  fromAddress = null,
  toAddress = null,

  verificationResult = null,

  note = null,
  rawPayload = null,

  client,
}) {
  if (!isSupportedHistoryEvent(eventType)) {
    throw new Error(
      "unsupported_history_event_type"
    );
  }

  const finalEventKey =
    eventKey ||
    buildEventKey({
      provider,
      paymentOrderId,
      eventType,
      providerEventId,
      txHash,
      sequence,
    });

  const sanitizedPayload =
    sanitizePayload(rawPayload);

  return paymentRepository.insertCryptoHistoryEvent({
    paymentOrderId,
    userId,
    provider,

    eventKey: finalEventKey,
    eventType,

    orderStatus,

    asset,
    network,

    cryptoAmount,
    usdAmount,
    amountMicroUsd,

    txHash,

    providerOrderId,
    providerTransactionId,

    confirmations,
    requiredConfirmations,

    fromAddress,
    toAddress,

    verificationResult,

    note,
    rawPayload: sanitizedPayload,

    client,
  });
}

/**
 * Order created history।
 */
async function recordOrderCreated({
  order,
  client,
}) {
  if (!order) {
    throw new Error("payment_order_required");
  }

  return recordCryptoEvent({
    paymentOrderId: order.id,
    userId: order.user_id,
    provider: order.provider,

    eventType:
      CRYPTO_HISTORY_EVENT_TYPES.ORDER_CREATED,

    orderStatus: order.status,

    asset: order.asset,
    network: order.network,

    cryptoAmount:
      order.expected_crypto_amount,

    usdAmount:
      order.requested_amount_usd,

    amountMicroUsd:
      order.requested_amount_microusd,

    txHash: order.tx_hash,

    providerOrderId:
      order.provider_order_id,

    providerTransactionId:
      order.provider_transaction_id,

    toAddress:
      order.destination_address,

    verificationResult:
      VERIFICATION_RESULTS.PENDING,

    note: "Payment order created",

    rawPayload: {
      orderReference:
        order.order_reference,
      expiresAt: order.expires_at,
    },

    client,
  });
}

/**
 * User TXID submit history।
 */
async function recordTxSubmitted({
  order,
  txHash,
  rawPayload = null,
  client,
}) {
  if (!order) {
    throw new Error("payment_order_required");
  }

  return recordCryptoEvent({
    paymentOrderId: order.id,
    userId: order.user_id,
    provider: order.provider,

    eventType:
      CRYPTO_HISTORY_EVENT_TYPES.TX_SUBMITTED,

    providerEventId: txHash,
    txHash,

    orderStatus: order.status,

    asset: order.asset,
    network: order.network,

    cryptoAmount:
      order.expected_crypto_amount,

    usdAmount:
      order.requested_amount_usd,

    amountMicroUsd:
      order.requested_amount_microusd,

    toAddress:
      order.destination_address,

    verificationResult:
      VERIFICATION_RESULTS.PENDING,

    note: "Transaction hash submitted",

    rawPayload,

    client,
  });
}

/**
 * Binance/API deposit detection history।
 */
async function recordDepositDetected({
  order,
  providerEventId,
  providerTransactionId = null,
  txHash = null,

  cryptoAmount = null,

  confirmations = null,
  requiredConfirmations = null,

  fromAddress = null,
  toAddress = null,

  rawPayload = null,
  client,
}) {
  if (!order) {
    throw new Error("payment_order_required");
  }

  return recordCryptoEvent({
    paymentOrderId: order.id,
    userId: order.user_id,
    provider: order.provider,

    eventType:
      CRYPTO_HISTORY_EVENT_TYPES
        .DEPOSIT_DETECTED,

    providerEventId,
    txHash,

    orderStatus: order.status,

    asset: order.asset,
    network: order.network,

    cryptoAmount,

    usdAmount:
      order.requested_amount_usd,

    amountMicroUsd:
      order.requested_amount_microusd,

    providerOrderId:
      order.provider_order_id,

    providerTransactionId,

    confirmations,
    requiredConfirmations,

    fromAddress,
    toAddress,

    verificationResult:
      VERIFICATION_RESULTS.PENDING,

    note: "Crypto deposit detected",

    rawPayload,

    client,
  });
}

/**
 * Confirmation progress history।
 */
async function recordConfirmationUpdated({
  order,
  providerEventId,
  txHash,

  confirmations,
  requiredConfirmations,

  rawPayload = null,
  client,
}) {
  if (!order) {
    throw new Error("payment_order_required");
  }

  return recordCryptoEvent({
    paymentOrderId: order.id,
    userId: order.user_id,
    provider: order.provider,

    eventType:
      CRYPTO_HISTORY_EVENT_TYPES
        .CONFIRMATION_UPDATED,

    providerEventId,
    txHash,
    sequence: confirmations,

    orderStatus: order.status,

    asset: order.asset,
    network: order.network,

    cryptoAmount:
      order.expected_crypto_amount,

    usdAmount:
      order.requested_amount_usd,

    amountMicroUsd:
      order.requested_amount_microusd,

    confirmations,
    requiredConfirmations,

    toAddress:
      order.destination_address,

    verificationResult:
      VERIFICATION_RESULTS.PENDING,

    note: "Blockchain confirmation updated",

    rawPayload,

    client,
  });
}

/**
 * Verification success history।
 */
async function recordVerificationPassed({
  order,

  providerEventId = null,
  providerTransactionId = null,
  txHash = null,

  cryptoAmount = null,

  confirmations = null,
  requiredConfirmations = null,

  rawPayload = null,
  client,
}) {
  if (!order) {
    throw new Error("payment_order_required");
  }

  return recordCryptoEvent({
    paymentOrderId: order.id,
    userId: order.user_id,
    provider: order.provider,

    eventType:
      CRYPTO_HISTORY_EVENT_TYPES
        .VERIFICATION_PASSED,

    providerEventId,
    txHash,

    orderStatus: order.status,

    asset: order.asset,
    network: order.network,

    cryptoAmount,

    usdAmount:
      order.requested_amount_usd,

    amountMicroUsd:
      order.requested_amount_microusd,

    providerOrderId:
      order.provider_order_id,

    providerTransactionId,

    confirmations,
    requiredConfirmations,

    toAddress:
      order.destination_address,

    verificationResult:
      VERIFICATION_RESULTS.PASSED,

    note: "Crypto payment verification passed",

    rawPayload,

    client,
  });
}

/**
 * Verification failure history।
 */
async function recordVerificationFailed({
  order,

  providerEventId = null,
  txHash = null,

  reason,
  rawPayload = null,
  client,
}) {
  if (!order) {
    throw new Error("payment_order_required");
  }

  return recordCryptoEvent({
    paymentOrderId: order.id,
    userId: order.user_id,
    provider: order.provider,

    eventType:
      CRYPTO_HISTORY_EVENT_TYPES
        .VERIFICATION_FAILED,

    providerEventId,
    txHash,

    orderStatus: order.status,

    asset: order.asset,
    network: order.network,

    cryptoAmount:
      order.expected_crypto_amount,

    usdAmount:
      order.requested_amount_usd,

    amountMicroUsd:
      order.requested_amount_microusd,

    toAddress:
      order.destination_address,

    verificationResult:
      VERIFICATION_RESULTS.FAILED,

    note:
      reason ||
      "Crypto payment verification failed",

    rawPayload,

    client,
  });
}

/**
 * Wallet credited history।
 */
async function recordWalletCredited({
  order,
  walletTransaction,
  rawPayload = null,
  client,
}) {
  if (!order) {
    throw new Error("payment_order_required");
  }

  if (!walletTransaction) {
    throw new Error(
      "wallet_transaction_required"
    );
  }

  return recordCryptoEvent({
    paymentOrderId: order.id,
    userId: order.user_id,
    provider: order.provider,

    eventType:
      CRYPTO_HISTORY_EVENT_TYPES
        .WALLET_CREDITED,

    providerEventId:
      walletTransaction.id,

    txHash: order.tx_hash,

    orderStatus: order.status,

    asset: order.asset,
    network: order.network,

    cryptoAmount:
      order.expected_crypto_amount,

    usdAmount:
      order.requested_amount_usd,

    amountMicroUsd:
      order.requested_amount_microusd,

    providerOrderId:
      order.provider_order_id,

    providerTransactionId:
      order.provider_transaction_id,

    toAddress:
      order.destination_address,

    verificationResult:
      VERIFICATION_RESULTS.PASSED,

    note: "NetPhone wallet credited",

    rawPayload: {
      walletTransactionId:
        walletTransaction.id,
      walletReference:
        walletTransaction.reference,
      walletStatus:
        walletTransaction.status,
      providerPayload:
        sanitizePayload(rawPayload),
    },

    client,
  });
}

/**
 * Manual review history।
 */
async function recordManualReview({
  order,
  reason,
  rawPayload = null,
  client,
}) {
  if (!order) {
    throw new Error("payment_order_required");
  }

  return recordCryptoEvent({
    paymentOrderId: order.id,
    userId: order.user_id,
    provider: order.provider,

    eventType:
      CRYPTO_HISTORY_EVENT_TYPES.MANUAL_REVIEW,

    providerEventId:
      reason || "manual-review",

    txHash: order.tx_hash,

    orderStatus: order.status,

    asset: order.asset,
    network: order.network,

    cryptoAmount:
      order.expected_crypto_amount,

    usdAmount:
      order.requested_amount_usd,

    amountMicroUsd:
      order.requested_amount_microusd,

    verificationResult:
      VERIFICATION_RESULTS.MANUAL_REVIEW,

    note:
      reason ||
      "Payment requires manual review",

    rawPayload,

    client,
  });
}

module.exports = {
  sanitizePayload,
  buildEventKey,

  recordCryptoEvent,

  recordOrderCreated,
  recordTxSubmitted,
  recordDepositDetected,
  recordConfirmationUpdated,

  recordVerificationPassed,
  recordVerificationFailed,

  recordWalletCredited,
  recordManualReview,
};