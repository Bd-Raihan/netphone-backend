"use strict";

const crypto = require("crypto");

const db = require("../../config/db");
const walletService = require("../wallet/wallet.service");

const paymentRepository = require("./payment.repository");
const paymentHistoryService = require(
  "./payment.history.service"
);

const {
  PAYMENT_PROVIDERS,
  PAYMENT_STATUSES,
  PAYMENT_TYPES,
  CRYPTO_HISTORY_EVENT_TYPES,
  VERIFICATION_RESULTS,
  WALLET_TRANSACTION_TYPES,
  usdToMicroUsd,
  isSupportedProvider,
} = require("./payment.constants");

const MIN_RECHARGE_USD = 5;
const MAX_RECHARGE_USD = 500;

/**
 * Public order reference তৈরি।
 *
 * Example:
 * NP-CRYPTO-20260804-A1B2C3D4E5F6
 */
function generateOrderReference() {
  const datePart = new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");

  const randomPart = crypto
    .randomBytes(6)
    .toString("hex")
    .toUpperCase();

  return `NP-CRYPTO-${datePart}-${randomPart}`;
}

function normalizePositiveId(
  value,
  fieldName = "id"
) {
  const normalized = Number(value);

  if (
    !Number.isInteger(normalized) ||
    normalized <= 0
  ) {
    throw new Error(`invalid_${fieldName}`);
  }

  return normalized;
}

function normalizeUsdAmount(value) {
  const amount = Number(value);

  if (
    !Number.isFinite(amount) ||
    amount < MIN_RECHARGE_USD ||
    amount > MAX_RECHARGE_USD
  ) {
    throw new Error(
      `recharge_amount_must_be_between_${MIN_RECHARGE_USD}_and_${MAX_RECHARGE_USD}_usd`
    );
  }

  return Number(amount.toFixed(2));
}

function normalizeOptionalText(
  value,
  maxLength = 500
) {
  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  const normalized = String(value).trim();

  if (!normalized) {
    return null;
  }

  return normalized.slice(0, maxLength);
}

function assertProvider(provider) {
  if (!isSupportedProvider(provider)) {
    throw new Error(
      "unsupported_payment_provider"
    );
  }
}

/**
 * Generic payment order create।
 *
 * Provider-specific service পরে destination address,
 * expected crypto amount অথবা Binance order ID update করবে।
 */
async function createPaymentOrder({
  userId,
  provider,
  amountUsd,

  asset = null,
  network = null,

  expectedCryptoAmount = null,
  destinationAddress = null,
  destinationTag = null,

  providerOrderId = null,
  manualRechargeRequestId = null,

  expiresAt = null,
  metadata = null,
}) {
  const normalizedUserId =
    normalizePositiveId(userId, "user_id");

  assertProvider(provider);

  const normalizedAmountUsd =
    normalizeUsdAmount(amountUsd);

  const amountMicroUsd =
    usdToMicroUsd(normalizedAmountUsd);

  const client = await db.getClient();

  try {
    await client.query("BEGIN");

    let order = null;

    /*
     * Rare reference collision হলে কয়েকবার নতুন reference চেষ্টা।
     */
    for (
      let attempt = 1;
      attempt <= 3;
      attempt += 1
    ) {
      const orderReference =
        generateOrderReference();

      try {
        order =
          await paymentRepository
            .createPaymentOrder({
              orderReference,

              userId:
                normalizedUserId,

              provider,

              paymentType:
                PAYMENT_TYPES
                  .CRYPTO_RECHARGE,

              requestedAmountUsd:
                normalizedAmountUsd,

              requestedAmountMicroUsd:
                amountMicroUsd,

              asset:
                normalizeOptionalText(
                  asset,
                  20
                ),

              network:
                normalizeOptionalText(
                  network,
                  40
                ),

              expectedCryptoAmount,

              destinationAddress:
                normalizeOptionalText(
                  destinationAddress,
                  1000
                ),

              destinationTag:
                normalizeOptionalText(
                  destinationTag,
                  500
                ),

              providerOrderId:
                normalizeOptionalText(
                  providerOrderId,
                  500
                ),

              status:
                PAYMENT_STATUSES.CREATED,

              manualRechargeRequestId,

              expiresAt,

              metadata: {
                ...(metadata || {}),
                engine_version:
                  "payment-engine-v1",
              },

              client,
            });

        break;
      } catch (error) {
        /*
         * PostgreSQL unique violation:
         * order_reference collision হলে retry।
         */
        if (
          error.code === "23505" &&
          String(
            error.constraint || ""
          ).includes(
            "order_reference"
          )
        ) {
          continue;
        }

        throw error;
      }
    }

    if (!order) {
      throw new Error(
        "unable_to_generate_unique_order_reference"
      );
    }

    await paymentHistoryService
      .recordOrderCreated({
        order,
        client,
      });

    await client.query("COMMIT");

    return order;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // Original error preserve হবে।
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * User নিজের order দেখবে।
 */
async function getUserOrder({
  userId,
  orderReference,
}) {
  const normalizedUserId =
    normalizePositiveId(userId, "user_id");

  const normalizedReference =
    normalizeOptionalText(
      orderReference,
      80
    );

  if (!normalizedReference) {
    throw new Error(
      "order_reference_required"
    );
  }

  const order =
    await paymentRepository
      .getUserPaymentOrder({
        userId: normalizedUserId,
        orderReference:
          normalizedReference,
      });

  if (!order) {
    throw new Error(
      "payment_order_not_found"
    );
  }

  return order;
}

/**
 * User payment order list।
 */
async function listUserOrders({
  userId,
  limit = 20,
  offset = 0,
}) {
  return paymentRepository
    .listUserPaymentOrders({
      userId:
        normalizePositiveId(
          userId,
          "user_id"
        ),

      limit,
      offset,
    });
}

/**
 * User-এর আলাদা Crypto Transaction History।
 */
async function listUserCryptoHistory({
  userId,
  limit = 50,
  offset = 0,
}) {
  return paymentRepository
    .listUserCryptoHistory({
      userId:
        normalizePositiveId(
          userId,
          "user_id"
        ),

      limit,
      offset,
    });
}

/**
 * Manual Crypto অথবা Binance On-chain order-এ
 * user TXID submit করবে।
 *
 * এটি payment verify বা wallet credit করে না।
 */
async function submitTransactionHash({
  userId,
  orderReference,
  txHash,
}) {
  const normalizedUserId =
    normalizePositiveId(userId, "user_id");

  const normalizedReference =
    normalizeOptionalText(
      orderReference,
      80
    );

  const normalizedTxHash =
    normalizeOptionalText(
      txHash,
      500
    );

  if (!normalizedReference) {
    throw new Error(
      "order_reference_required"
    );
  }

  if (
    !normalizedTxHash ||
    normalizedTxHash.length < 20
  ) {
    throw new Error(
      "invalid_transaction_hash"
    );
  }

  const client = await db.getClient();

  try {
    await client.query("BEGIN");

    const orderResult =
      await client.query(
        `
          SELECT *
          FROM payment_orders
          WHERE order_reference = $1
            AND user_id = $2
          FOR UPDATE
        `,
        [
          normalizedReference,
          normalizedUserId,
        ]
      );

    const order =
      orderResult.rows[0];

    if (!order) {
      throw new Error(
        "payment_order_not_found"
      );
    }

    if (
      ![
        PAYMENT_PROVIDERS.MANUAL_CRYPTO,
        PAYMENT_PROVIDERS.BINANCE_ONCHAIN,
      ].includes(order.provider)
    ) {
      throw new Error(
        "tx_hash_not_supported_for_provider"
      );
    }

    if (
      [
        PAYMENT_STATUSES.CREDITED,
        PAYMENT_STATUSES.CANCELLED,
        PAYMENT_STATUSES.EXPIRED,
        PAYMENT_STATUSES.REJECTED,
      ].includes(order.status)
    ) {
      throw new Error(
        "payment_order_already_finalized"
      );
    }

    const duplicateOrder =
      await paymentRepository
        .findOrderByTxHash({
          provider: order.provider,
          txHash: normalizedTxHash,
          client,
        });

    if (
      duplicateOrder &&
      Number(duplicateOrder.id) !==
        Number(order.id)
    ) {
      throw new Error(
        "transaction_hash_already_used"
      );
    }

    const updatedOrder =
      await paymentRepository
        .updatePaymentOrder({
          orderId: order.id,

          txHash:
            normalizedTxHash,

          status:
            PAYMENT_STATUSES
              .PAYMENT_DETECTED,

          paymentDetectedAt:
            new Date(),

          client,
        });

    await paymentHistoryService
      .recordTxSubmitted({
        order: updatedOrder,
        txHash: normalizedTxHash,

        rawPayload: {
          submitted_by_user:
            normalizedUserId,
        },

        client,
      });

    await client.query("COMMIT");

    return updatedOrder;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // Original error preserve হবে।
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Verified payment wallet-এ credit করে।
 *
 * এই function শুধুমাত্র provider verifier অথবা
 * secure admin/manual approval service call করবে।
 *
 * Flutter/User request সরাসরি এই function call করবে না।
 */
async function creditVerifiedPayment({
  orderId,
  verifiedProvider,

  providerOrderId = undefined,
  providerTransactionId = undefined,
  txHash = undefined,

  asset = undefined,
  network = undefined,
  cryptoAmount = null,

  confirmations = null,
  requiredConfirmations = null,

  providerPayload = null,
  verificationNote = null,
}) {
  const normalizedOrderId =
    normalizePositiveId(
      orderId,
      "order_id"
    );

  assertProvider(verifiedProvider);

  const client = await db.getClient();

  try {
    await client.query("BEGIN");

    const order =
      await paymentRepository
        .lockPaymentOrderById({
          orderId:
            normalizedOrderId,
          client,
        });

    if (!order) {
      throw new Error(
        "payment_order_not_found"
      );
    }

    if (
      order.provider !==
      verifiedProvider
    ) {
      throw new Error(
        "payment_provider_mismatch"
      );
    }

    /*
     * ইতোমধ্যে credited হলে idempotent success।
     */
    if (
      order.status ===
        PAYMENT_STATUSES.CREDITED &&
      order.wallet_tx_id
    ) {
      await client.query("COMMIT");

      return {
        ok: true,
        duplicated: true,
        order,
      };
    }

    if (
      [
        PAYMENT_STATUSES.CANCELLED,
        PAYMENT_STATUSES.EXPIRED,
        PAYMENT_STATUSES.REJECTED,
      ].includes(order.status)
    ) {
      throw new Error(
        "payment_order_cannot_be_credited"
      );
    }

    const finalTxHash =
      txHash !== undefined
        ? normalizeOptionalText(
            txHash,
            500
          )
        : order.tx_hash;

    const finalProviderTransactionId =
      providerTransactionId !== undefined
        ? normalizeOptionalText(
            providerTransactionId,
            500
          )
        : order.provider_transaction_id;

    if (finalTxHash) {
      const duplicateTx =
        await paymentRepository
          .findOrderByTxHash({
            provider:
              order.provider,

            txHash:
              finalTxHash,

            client,
          });

      if (
        duplicateTx &&
        Number(duplicateTx.id) !==
          Number(order.id)
      ) {
        throw new Error(
          "transaction_hash_already_used"
        );
      }
    }

    if (finalProviderTransactionId) {
      const duplicateProviderTx =
        await paymentRepository
          .findOrderByProviderTransactionId({
            provider:
              order.provider,

            providerTransactionId:
              finalProviderTransactionId,

            client,
          });

      if (
        duplicateProviderTx &&
        Number(
          duplicateProviderTx.id
        ) !== Number(order.id)
      ) {
        throw new Error(
          "provider_transaction_already_used"
        );
      }
    }

    /*
     * Wallet idempotency key:
     * একই payment order দ্বিতীয়বার wallet credit করবে না।
     */
    const walletIdempotencyKey =
      `payment_order_${order.id}`;

    const walletResult =
      await walletService
        .applyWalletTxWithClient({
          client,

          userId:
            order.user_id,

          currency:
            "USD",

          amountMicroUsd:
            Number(
              order
                .requested_amount_microusd
            ),

          txType:
            WALLET_TRANSACTION_TYPES
              .RECHARGE,

          idempotencyKey:
            walletIdempotencyKey,

          reference:
            order.order_reference,

          meta: {
            source:
              "payment_engine",

            payment_order_id:
              order.id,

            order_reference:
              order.order_reference,

            provider:
              order.provider,

            provider_order_id:
              providerOrderId ??
              order.provider_order_id,

            provider_transaction_id:
              finalProviderTransactionId,

            tx_hash:
              finalTxHash,

            asset:
              asset ??
              order.asset,

            network:
              network ??
              order.network,
          },
        });

    if (
      !walletResult ||
      !walletResult.ok ||
      !walletResult.tx
    ) {
      throw new Error(
        "wallet_credit_failed"
      );
    }

    const creditedAt =
      new Date();

    const creditedOrder =
      await paymentRepository
        .updatePaymentOrder({
          orderId:
            order.id,

          status:
            PAYMENT_STATUSES.CREDITED,

          providerOrderId:
            providerOrderId !== undefined
              ? normalizeOptionalText(
                  providerOrderId,
                  500
                )
              : order.provider_order_id,

          providerTransactionId:
            finalProviderTransactionId,

          txHash:
            finalTxHash,

          asset:
            asset !== undefined
              ? normalizeOptionalText(
                  asset,
                  20
                )
              : order.asset,

          network:
            network !== undefined
              ? normalizeOptionalText(
                  network,
                  40
                )
              : order.network,

          paidAt:
            order.paid_at ||
            creditedAt,

          creditedAt,

          walletTxId:
            walletResult.tx.id,

          metadata: {
            ...(order.metadata || {}),

            verification: {
              result:
                VERIFICATION_RESULTS
                  .PASSED,

              note:
                verificationNote ||
                "Provider payment verified",

              confirmations,

              required_confirmations:
                requiredConfirmations,
            },
          },

          client,
        });

    await paymentHistoryService
      .recordVerificationPassed({
        order:
          creditedOrder,

        providerEventId:
          finalProviderTransactionId ||
          finalTxHash ||
          order.id,

        providerTransactionId:
          finalProviderTransactionId,

        txHash:
          finalTxHash,

        cryptoAmount,

        confirmations,
        requiredConfirmations,

        rawPayload:
          providerPayload,

        client,
      });

    await paymentHistoryService
      .recordCryptoEvent({
        paymentOrderId:
          creditedOrder.id,

        userId:
          creditedOrder.user_id,

        provider:
          creditedOrder.provider,

        eventType:
          CRYPTO_HISTORY_EVENT_TYPES
            .PAYMENT_PAID,

        providerEventId:
          finalProviderTransactionId ||
          finalTxHash ||
          creditedOrder.id,

        txHash:
          finalTxHash,

        orderStatus:
          PAYMENT_STATUSES.CREDITED,

        asset:
          creditedOrder.asset,

        network:
          creditedOrder.network,

        cryptoAmount,

        usdAmount:
          creditedOrder
            .requested_amount_usd,

        amountMicroUsd:
          creditedOrder
            .requested_amount_microusd,

        providerOrderId:
          creditedOrder
            .provider_order_id,

        providerTransactionId:
          creditedOrder
            .provider_transaction_id,

        confirmations,
        requiredConfirmations,

        verificationResult:
          VERIFICATION_RESULTS.PASSED,

        note:
          "Verified crypto payment paid",

        rawPayload:
          providerPayload,

        client,
      });

    await paymentHistoryService
      .recordWalletCredited({
        order:
          creditedOrder,

        walletTransaction:
          walletResult.tx,

        rawPayload:
          providerPayload,

        client,
      });

    await client.query("COMMIT");

    return {
      ok: true,

      duplicated:
        Boolean(
          walletResult.duplicated
        ),

      order:
        creditedOrder,

      wallet:
        walletResult.wallet,

      walletTransaction:
        walletResult.tx,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // Original error preserve হবে।
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Provider verification ব্যর্থ হলে history এবং status।
 */
async function markPaymentForManualReview({
  orderId,
  provider,
  reason,
  providerPayload = null,
}) {
  const normalizedOrderId =
    normalizePositiveId(
      orderId,
      "order_id"
    );

  assertProvider(provider);

  const client = await db.getClient();

  try {
    await client.query("BEGIN");

    const order =
      await paymentRepository
        .lockPaymentOrderById({
          orderId:
            normalizedOrderId,

          client,
        });

    if (!order) {
      throw new Error(
        "payment_order_not_found"
      );
    }

    if (
      order.provider !== provider
    ) {
      throw new Error(
        "payment_provider_mismatch"
      );
    }

    if (
      order.status ===
      PAYMENT_STATUSES.CREDITED
    ) {
      throw new Error(
        "credited_order_cannot_enter_manual_review"
      );
    }

    const updatedOrder =
      await paymentRepository
        .updatePaymentOrder({
          orderId:
            order.id,

          status:
            PAYMENT_STATUSES
              .MANUAL_REVIEW,

          failureCode:
            "verification_review_required",

          failureMessage:
            normalizeOptionalText(
              reason,
              2000
            ),

          client,
        });

    await paymentHistoryService
      .recordManualReview({
        order:
          updatedOrder,

        reason:
          reason ||
          "Payment requires manual review",

        rawPayload:
          providerPayload,

        client,
      });

    await client.query("COMMIT");

    return updatedOrder;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // Original error preserve হবে।
    }

    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  MIN_RECHARGE_USD,
  MAX_RECHARGE_USD,

  generateOrderReference,

  createPaymentOrder,

  getUserOrder,
  listUserOrders,
  listUserCryptoHistory,

  submitTransactionHash,

  creditVerifiedPayment,
  markPaymentForManualReview,
};