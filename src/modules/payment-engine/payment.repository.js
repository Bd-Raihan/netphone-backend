"use strict";

const db = require("../../config/db");

const {
  PAYMENT_TYPES,
  PAYMENT_STATUSES,
  isSupportedProvider,
  isSupportedPaymentStatus,
} = require("./payment.constants");

/**
 * JSON safely stringify করা।
 */
function toJson(value) {
  if (!value) {
    return "{}";
  }

  return JSON.stringify(value);
}

/**
 * PostgreSQL BIGINT নিরাপদভাবে number-এ convert করা।
 */
function normalizeId(value, fieldName = "id") {
  const normalized = Number(value);

  if (
    !Number.isInteger(normalized) ||
    normalized <= 0
  ) {
    throw new Error(`invalid_${fieldName}`);
  }

  return normalized;
}

/**
 * Payment order create।
 */
async function createPaymentOrder({
  orderReference,
  userId,
  provider,

  paymentType = PAYMENT_TYPES.CRYPTO_RECHARGE,

  requestedAmountUsd,
  requestedAmountMicroUsd,

  asset = null,
  network = null,
  expectedCryptoAmount = null,

  destinationAddress = null,
  destinationTag = null,

  providerOrderId = null,
  providerTransactionId = null,
  txHash = null,

  status = PAYMENT_STATUSES.CREATED,

  manualRechargeRequestId = null,
  expiresAt = null,

  metadata = null,

  client = db,
}) {
  if (
    typeof orderReference !== "string" ||
    orderReference.trim().length < 8
  ) {
    throw new Error("invalid_order_reference");
  }

  if (!isSupportedProvider(provider)) {
    throw new Error("unsupported_payment_provider");
  }

  if (!isSupportedPaymentStatus(status)) {
    throw new Error("unsupported_payment_status");
  }

  const normalizedUserId =
    normalizeId(userId, "user_id");

  const requestedUsd =
    Number(requestedAmountUsd);

  const requestedMicroUsd =
    Number(requestedAmountMicroUsd);

  if (
    !Number.isFinite(requestedUsd) ||
    requestedUsd <= 0
  ) {
    throw new Error("invalid_requested_amount_usd");
  }

  if (
    !Number.isSafeInteger(requestedMicroUsd) ||
    requestedMicroUsd <= 0
  ) {
    throw new Error(
      "invalid_requested_amount_microusd"
    );
  }

  const { rows } = await client.query(
    `
      INSERT INTO payment_orders (
        order_reference,
        user_id,
        provider,
        payment_type,

        requested_amount_usd,
        requested_amount_microusd,

        asset,
        network,
        expected_crypto_amount,

        destination_address,
        destination_tag,

        provider_order_id,
        provider_transaction_id,
        tx_hash,

        status,

        manual_recharge_request_id,
        expires_at,

        metadata
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,

        $5,
        $6,

        $7,
        $8,
        $9,

        $10,
        $11,

        $12,
        $13,
        $14,

        $15,

        $16,
        $17,

        $18::jsonb
      )
      RETURNING *
    `,
    [
      orderReference.trim(),
      normalizedUserId,
      provider,
      paymentType,

      requestedUsd,
      requestedMicroUsd,

      asset,
      network,
      expectedCryptoAmount,

      destinationAddress,
      destinationTag,

      providerOrderId,
      providerTransactionId,
      txHash,

      status,

      manualRechargeRequestId,
      expiresAt,

      toJson(metadata),
    ]
  );

  return rows[0];
}

/**
 * Order ID দিয়ে payment order।
 */
async function getPaymentOrderById(
  orderId,
  client = db
) {
  const normalizedOrderId =
    normalizeId(orderId, "order_id");

  const { rows } = await client.query(
    `
      SELECT *
      FROM payment_orders
      WHERE id = $1
      LIMIT 1
    `,
    [normalizedOrderId]
  );

  return rows[0] || null;
}

/**
 * Public order reference দিয়ে order।
 */
async function getPaymentOrderByReference(
  orderReference,
  client = db
) {
  if (
    typeof orderReference !== "string" ||
    !orderReference.trim()
  ) {
    throw new Error("invalid_order_reference");
  }

  const { rows } = await client.query(
    `
      SELECT *
      FROM payment_orders
      WHERE order_reference = $1
      LIMIT 1
    `,
    [orderReference.trim()]
  );

  return rows[0] || null;
}

/**
 * User ownership সহ order fetch।
 */
async function getUserPaymentOrder({
  orderReference,
  userId,
  client = db,
}) {
  const normalizedUserId =
    normalizeId(userId, "user_id");

  const { rows } = await client.query(
    `
      SELECT *
      FROM payment_orders
      WHERE order_reference = $1
        AND user_id = $2
      LIMIT 1
    `,
    [
      orderReference.trim(),
      normalizedUserId,
    ]
  );

  return rows[0] || null;
}

/**
 * Atomic processing-এর জন্য order row lock।
 *
 * এটি শুধুমাত্র active DB transaction-এর ভিতরে ব্যবহার করতে হবে।
 */
async function lockPaymentOrderById({
  orderId,
  client,
}) {
  if (!client) {
    throw new Error("database_client_required");
  }

  const normalizedOrderId =
    normalizeId(orderId, "order_id");

  const { rows } = await client.query(
    `
      SELECT *
      FROM payment_orders
      WHERE id = $1
      FOR UPDATE
    `,
    [normalizedOrderId]
  );

  return rows[0] || null;
}

/**
 * Order-এর মূল status/provider verification fields update।
 */
async function updatePaymentOrder({
  orderId,

  status,

  providerOrderId,
  providerTransactionId,
  txHash,

  asset,
  network,
  expectedCryptoAmount,

  destinationAddress,
  destinationTag,

  paymentDetectedAt,
  paidAt,
  creditedAt,
  failedAt,

  failureCode,
  failureMessage,

  walletTxId,
  metadata,

  client = db,
}) {
  const normalizedOrderId =
    normalizeId(orderId, "order_id");

  if (
    status !== undefined &&
    !isSupportedPaymentStatus(status)
  ) {
    throw new Error("unsupported_payment_status");
  }

  const updates = [];
  const values = [];

  function addUpdate(column, value) {
    values.push(value);

    updates.push(
      `${column} = $${values.length}`
    );
  }

  if (status !== undefined) {
    addUpdate("status", status);
  }

  if (providerOrderId !== undefined) {
    addUpdate(
      "provider_order_id",
      providerOrderId
    );
  }

  if (providerTransactionId !== undefined) {
    addUpdate(
      "provider_transaction_id",
      providerTransactionId
    );
  }

  if (txHash !== undefined) {
    addUpdate("tx_hash", txHash);
  }

  if (asset !== undefined) {
    addUpdate("asset", asset);
  }

  if (network !== undefined) {
    addUpdate("network", network);
  }

  if (expectedCryptoAmount !== undefined) {
    addUpdate(
      "expected_crypto_amount",
      expectedCryptoAmount
    );
  }

  if (destinationAddress !== undefined) {
    addUpdate(
      "destination_address",
      destinationAddress
    );
  }

  if (destinationTag !== undefined) {
    addUpdate(
      "destination_tag",
      destinationTag
    );
  }

  if (paymentDetectedAt !== undefined) {
    addUpdate(
      "payment_detected_at",
      paymentDetectedAt
    );
  }

  if (paidAt !== undefined) {
    addUpdate("paid_at", paidAt);
  }

  if (creditedAt !== undefined) {
    addUpdate("credited_at", creditedAt);
  }

  if (failedAt !== undefined) {
    addUpdate("failed_at", failedAt);
  }

  if (failureCode !== undefined) {
    addUpdate("failure_code", failureCode);
  }

  if (failureMessage !== undefined) {
    addUpdate(
      "failure_message",
      failureMessage
    );
  }

  if (walletTxId !== undefined) {
    addUpdate("wallet_tx_id", walletTxId);
  }

  if (metadata !== undefined) {
    values.push(toJson(metadata));

    updates.push(
      `metadata = $${values.length}::jsonb`
    );
  }

  if (!updates.length) {
    return getPaymentOrderById(
      normalizedOrderId,
      client
    );
  }

  values.push(normalizedOrderId);

  const { rows } = await client.query(
    `
      UPDATE payment_orders
      SET
        ${updates.join(",\n        ")}
      WHERE id = $${values.length}
      RETURNING *
    `,
    values
  );

  return rows[0] || null;
}

/**
 * Crypto lifecycle history event insert।
 *
 * provider + event_key database unique হওয়ায় একই event
 * দ্বিতীয়বার insert হলে duplicate হিসেবে ধরা হবে।
 */
async function insertCryptoHistoryEvent({
  paymentOrderId,
  userId,
  provider,

  eventKey,
  eventType,

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

  client = db,
}) {
  const normalizedPaymentOrderId =
    normalizeId(
      paymentOrderId,
      "payment_order_id"
    );

  const normalizedUserId =
    normalizeId(userId, "user_id");

  if (!isSupportedProvider(provider)) {
    throw new Error("unsupported_payment_provider");
  }

  if (
    typeof eventKey !== "string" ||
    !eventKey.trim()
  ) {
    throw new Error("invalid_event_key");
  }

  if (
    typeof eventType !== "string" ||
    !eventType.trim()
  ) {
    throw new Error("invalid_event_type");
  }

  const { rows } = await client.query(
    `
      INSERT INTO crypto_transaction_history (
        payment_order_id,
        user_id,
        provider,

        event_key,
        event_type,
        order_status,

        asset,
        network,

        crypto_amount,
        usd_amount,
        amount_microusd,

        tx_hash,

        provider_order_id,
        provider_transaction_id,

        confirmations,
        required_confirmations,

        from_address,
        to_address,

        verification_result,

        note,
        raw_payload
      )
      VALUES (
        $1,
        $2,
        $3,

        $4,
        $5,
        $6,

        $7,
        $8,

        $9,
        $10,
        $11,

        $12,

        $13,
        $14,

        $15,
        $16,

        $17,
        $18,

        $19,

        $20,
        $21::jsonb
      )
      ON CONFLICT (
        provider,
        event_key
      )
      DO NOTHING
      RETURNING *
    `,
    [
      normalizedPaymentOrderId,
      normalizedUserId,
      provider,

      eventKey.trim(),
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
      toJson(rawPayload),
    ]
  );

  return {
    inserted: Boolean(rows[0]),
    event: rows[0] || null,
  };
}

/**
 * User-এর crypto transaction history।
 */
async function listUserCryptoHistory({
  userId,
  limit = 50,
  offset = 0,
  client = db,
}) {
  const normalizedUserId =
    normalizeId(userId, "user_id");

  const normalizedLimit = Math.min(
    Math.max(Number(limit) || 50, 1),
    100
  );

  const normalizedOffset = Math.max(
    Number(offset) || 0,
    0
  );

  const { rows } = await client.query(
    `
      SELECT
        cth.*,

        po.order_reference,
        po.status AS payment_status,
        po.requested_amount_usd,
        po.requested_amount_microusd

      FROM crypto_transaction_history cth

      INNER JOIN payment_orders po
        ON po.id = cth.payment_order_id

      WHERE cth.user_id = $1

      ORDER BY
        cth.created_at DESC,
        cth.id DESC

      LIMIT $2
      OFFSET $3
    `,
    [
      normalizedUserId,
      normalizedLimit,
      normalizedOffset,
    ]
  );

  return rows;
}

/**
 * User-এর payment order history।
 */
async function listUserPaymentOrders({
  userId,
  limit = 20,
  offset = 0,
  client = db,
}) {
  const normalizedUserId =
    normalizeId(userId, "user_id");

  const normalizedLimit = Math.min(
    Math.max(Number(limit) || 20, 1),
    100
  );

  const normalizedOffset = Math.max(
    Number(offset) || 0,
    0
  );

  const { rows } = await client.query(
    `
      SELECT *
      FROM payment_orders

      WHERE user_id = $1

      ORDER BY
        created_at DESC,
        id DESC

      LIMIT $2
      OFFSET $3
    `,
    [
      normalizedUserId,
      normalizedLimit,
      normalizedOffset,
    ]
  );

  return rows;
}

/**
 * Blockchain TX hash আগে ব্যবহার হয়েছে কিনা।
 */
async function findOrderByTxHash({
  provider,
  txHash,
  client = db,
}) {
  if (!isSupportedProvider(provider)) {
    throw new Error("unsupported_payment_provider");
  }

  if (
    typeof txHash !== "string" ||
    !txHash.trim()
  ) {
    return null;
  }

  const { rows } = await client.query(
    `
      SELECT *
      FROM payment_orders

      WHERE provider = $1
        AND LOWER(tx_hash) =
            LOWER($2)

      LIMIT 1
    `,
    [
      provider,
      txHash.trim(),
    ]
  );

  return rows[0] || null;
}

/**
 * Provider transaction ID duplicate check।
 */
async function findOrderByProviderTransactionId({
  provider,
  providerTransactionId,
  client = db,
}) {
  if (!isSupportedProvider(provider)) {
    throw new Error("unsupported_payment_provider");
  }

  if (
    typeof providerTransactionId !== "string" ||
    !providerTransactionId.trim()
  ) {
    return null;
  }

  const { rows } = await client.query(
    `
      SELECT *
      FROM payment_orders

      WHERE provider = $1
        AND provider_transaction_id = $2

      LIMIT 1
    `,
    [
      provider,
      providerTransactionId.trim(),
    ]
  );

  return rows[0] || null;
}

/**
 * Expired এবং এখনো TXID না-পাওয়া payment order atomically finalize করে।
 *
 * Safety rules:
 * - শুধু created / awaiting_payment order
 * - expires_at ইতোমধ্যে পার হয়েছে
 * - tx_hash ও wallet_tx_id দুটোই NULL
 *
 * TXID submit করা বা verification চলমান order এখানে expire হবে না।
 */
async function expireUnpaidPaymentOrders({
  provider,
  limit = 100,
  client = db,
}) {
  if (!isSupportedProvider(provider)) {
    throw new Error("unsupported_payment_provider");
  }

  const normalizedLimit = Math.min(
    Math.max(Number(limit) || 100, 1),
    500
  );

  const { rows } = await client.query(
    `
      WITH candidates AS (
        SELECT
          po.id
        FROM payment_orders po
        WHERE po.provider = $1
          AND po.expires_at IS NOT NULL
          AND po.expires_at <= NOW()
          AND po.status IN (
            'created',
            'awaiting_payment'
          )
          AND po.tx_hash IS NULL
          AND po.wallet_tx_id IS NULL
        ORDER BY
          po.expires_at ASC,
          po.id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $2
      ),

      expired_orders AS (
        UPDATE payment_orders po
        SET
          status = 'expired',
          failure_code =
            'payment_order_expired',
          failure_message =
            'Payment order expired before transaction submission',
          metadata =
            COALESCE(
              po.metadata,
              '{}'::jsonb
            ) ||
            jsonb_build_object(
              'expired_by',
              'binance_reconciliation_worker',
              'expired_at',
              NOW()
            ),
          updated_at = NOW()
        FROM candidates c
        WHERE po.id = c.id
        RETURNING po.*
      ),

      cancelled_jobs AS (
        UPDATE payment_reconciliation_jobs prj
        SET
          job_status = 'cancelled',
          next_attempt_at = NOW(),
          locked_at = NULL,
          locked_by = NULL,
          last_finished_at = NOW(),
          last_error_code =
            'payment_order_expired',
          last_error_message =
            'Linked payment order expired before transaction submission',
          result_payload =
            COALESCE(
              prj.result_payload,
              '{}'::jsonb
            ) ||
            jsonb_build_object(
              'result',
              'expired',
              'expired_at',
              NOW()
            ),
          updated_at = NOW()
        WHERE prj.payment_order_id IN (
          SELECT id
          FROM expired_orders
        )
          AND prj.job_status <> 'completed'
        RETURNING
          prj.payment_order_id
      )

      SELECT
        eo.*,
        EXISTS (
          SELECT 1
          FROM cancelled_jobs cj
          WHERE cj.payment_order_id = eo.id
        ) AS reconciliation_job_cancelled
      FROM expired_orders eo
      ORDER BY eo.id ASC
    `,
    [
      provider,
      normalizedLimit,
    ]
  );

  return rows;
}

module.exports = {
  createPaymentOrder,

  getPaymentOrderById,
  getPaymentOrderByReference,
  getUserPaymentOrder,

  lockPaymentOrderById,
  updatePaymentOrder,
  expireUnpaidPaymentOrders,

  insertCryptoHistoryEvent,

  listUserCryptoHistory,
  listUserPaymentOrders,

  findOrderByTxHash,
  findOrderByProviderTransactionId,
};