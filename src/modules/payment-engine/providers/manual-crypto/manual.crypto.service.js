"use strict";

const db = require("../../../../config/db");

const paymentRepository = require(
  "../../payment.repository"
);

const paymentHistoryService = require(
  "../../payment.history.service"
);

const paymentOrderService = require(
  "../../payment.order.service"
);

const {
  PAYMENT_PROVIDERS,
  PAYMENT_TYPES,
  PAYMENT_STATUSES,
  usdToMicroUsd,
} = require("../../payment.constants");

const PROVIDER =
  PAYMENT_PROVIDERS.MANUAL_CRYPTO;

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
    amount <= 0
  ) {
    throw new Error(
      "invalid_recharge_amount_usd"
    );
  }

  return Number(amount.toFixed(2));
}

function normalizeText(
  value,
  fieldName,
  maxLength = 500
) {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new Error(
      `${fieldName}_required`
    );
  }

  return value
    .trim()
    .slice(0, maxLength);
}

function normalizeOptionalText(
  value,
  maxLength = 500
) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const normalized =
    String(value).trim();

  if (!normalized) {
    return null;
  }

  return normalized.slice(
    0,
    maxLength
  );
}

async function getProviderConfig({
  client = db,
  requireEnabled = true,
} = {}) {
  const { rows } =
    await client.query(
      `
        SELECT
          id,
          provider,
          display_name,
          priority,
          is_enabled,
          is_automatic,

          minimum_amount_usd,
          maximum_amount_usd,

          order_expiry_minutes,
          reconciliation_interval_seconds,
          max_retry_attempts,

          settings,
          created_at,
          updated_at

        FROM payment_provider_configs

        WHERE provider = $1

        LIMIT 1
      `,
      [PROVIDER]
    );

  const config =
    rows[0] || null;

  if (!config) {
    throw new Error(
      "manual_crypto_config_missing"
    );
  }

  if (
    requireEnabled &&
    !config.is_enabled
  ) {
    throw new Error(
      "manual_crypto_disabled"
    );
  }

  if (config.is_automatic) {
    throw new Error(
      "manual_crypto_must_not_be_automatic"
    );
  }

  return config;
}

/**
 * Manual fallback order।
 *
 * এটি automatic payment method নয়।
 * User TXID ও payment details submit করবে।
 * Order সরাসরি manual_review status-এ যাবে।
 */
async function createManualReviewOrder({
  userId,
  amountUsd,

  asset,
  network,

  txHash,
  walletAddress = null,

  note = null,
  metadata = null,
}) {
  const normalizedUserId =
    normalizePositiveId(
      userId,
      "user_id"
    );

  const normalizedAmountUsd =
    normalizeUsdAmount(
      amountUsd
    );

  const normalizedAsset =
    normalizeText(
      asset,
      "asset",
      20
    ).toUpperCase();

  const normalizedNetwork =
    normalizeText(
      network,
      "network",
      40
    ).toUpperCase();

  const normalizedTxHash =
    normalizeText(
      txHash,
      "transaction_hash",
      500
    );

  if (
    normalizedTxHash.length < 20
  ) {
    throw new Error(
      "invalid_transaction_hash"
    );
  }

  const client =
    await db.getClient();

  try {
    await client.query("BEGIN");

    const providerConfig =
      await getProviderConfig({
        client,
      });

    const minimumAmountUsd =
      Number(
        providerConfig
          .minimum_amount_usd
      );

    const maximumAmountUsd =
      Number(
        providerConfig
          .maximum_amount_usd
      );

    if (
      normalizedAmountUsd <
        minimumAmountUsd ||
      normalizedAmountUsd >
        maximumAmountUsd
    ) {
      throw new Error(
        `recharge_amount_must_be_between_${minimumAmountUsd}_and_${maximumAmountUsd}_usd`
      );
    }

    const duplicateOrder =
      await paymentRepository
        .findOrderByTxHash({
          provider:
            PROVIDER,

          txHash:
            normalizedTxHash,

          client,
        });

    if (duplicateOrder) {
      throw new Error(
        "transaction_hash_already_used"
      );
    }

    const amountMicroUsd =
      usdToMicroUsd(
        normalizedAmountUsd
      );

    const expiryMinutes =
      Number(
        providerConfig
          .order_expiry_minutes
      );

    const expiresAt =
      new Date(
        Date.now() +
          expiryMinutes *
            60 *
            1000
      );

    let order = null;

    for (
      let attempt = 1;
      attempt <= 3;
      attempt += 1
    ) {
      const orderReference =
        paymentOrderService
          .generateOrderReference();

      try {
        order =
          await paymentRepository
            .createPaymentOrder({
              orderReference,

              userId:
                normalizedUserId,

              provider:
                PROVIDER,

              paymentType:
                PAYMENT_TYPES
                  .CRYPTO_RECHARGE,

              requestedAmountUsd:
                normalizedAmountUsd,

              requestedAmountMicroUsd:
                amountMicroUsd,

              asset:
                normalizedAsset,

              network:
                normalizedNetwork,

              expectedCryptoAmount:
                null,

              destinationAddress:
                normalizeOptionalText(
                  walletAddress,
                  1000
                ),

              txHash:
                normalizedTxHash,

              status:
                PAYMENT_STATUSES
                  .MANUAL_REVIEW,

              expiresAt,

              metadata: {
                ...(metadata || {}),

                submitted_note:
                  normalizeOptionalText(
                    note,
                    2000
                  ),

                engine_version:
                  "payment-engine-v1",

                provider_mode:
                  "manual_crypto_review",
              },

              client,
            });

        break;
      } catch (error) {
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

    const updatedResult =
      await client.query(
        `
          UPDATE payment_orders

          SET
            payment_detected_at = NOW(),

            review_reason =
              'Manual crypto verification required',

            next_verification_at = NULL,

            updated_at = NOW()

          WHERE id = $1

          RETURNING *
        `,
        [order.id]
      );

    order =
      updatedResult.rows[0];

    await paymentHistoryService
      .recordOrderCreated({
        order,
        client,
      });

    await paymentHistoryService
      .recordTxSubmitted({
        order,
        txHash:
          normalizedTxHash,

        rawPayload: {
          submittedByUser:
            normalizedUserId,

          walletAddress:
            normalizeOptionalText(
              walletAddress,
              1000
            ),

          note:
            normalizeOptionalText(
              note,
              2000
            ),
        },

        client,
      });

    await paymentHistoryService
      .recordManualReview({
        order,

        reason:
          "Manual crypto verification required",

        rawPayload: {
          asset:
            normalizedAsset,

          network:
            normalizedNetwork,

          txHash:
            normalizedTxHash,
        },

        client,
      });

    await client.query("COMMIT");

    return {
      success: true,

      provider:
        PROVIDER,

      order: {
        id:
          order.id,

        orderReference:
          order.order_reference,

        status:
          order.status,

        amountUsd:
          order.requested_amount_usd,

        amountMicroUsd:
          order.requested_amount_microusd,

        asset:
          order.asset,

        network:
          order.network,

        txHash:
          order.tx_hash,

        reviewReason:
          order.review_reason,

        expiresAt:
          order.expires_at,

        createdAt:
          order.created_at,
      },

      message:
        "Payment submitted for manual review",
    };
  } catch (error) {
    try {
      await client.query(
        "ROLLBACK"
      );
    } catch (_) {
      // Original error preserve হবে।
    }

    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  PROVIDER,

  getProviderConfig,
  createManualReviewOrder,
};