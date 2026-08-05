"use strict";

const db = require("../../../../config/db");

const paymentRepository = require(
  "../../payment.repository"
);

const paymentHistoryService = require(
  "../../payment.history.service"
);

const reconciliationRepository = require(
  "../../payment.reconciliation.repository"
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
  PAYMENT_PROVIDERS.BINANCE_PAY;

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
      "binance_pay_config_missing"
    );
  }

  if (
    requireEnabled &&
    !config.is_enabled
  ) {
    throw new Error(
      "binance_pay_disabled"
    );
  }

  if (!config.is_automatic) {
    throw new Error(
      "binance_pay_not_automatic"
    );
  }

  return config;
}

/**
 * Binance Pay destination configuration.
 *
 * crypto_payment_methods.deposit_address-এ পরে
 * Binance Pay ID/email/recipient reference রাখা হবে।
 * Secret বা API key এখানে রাখা যাবে না।
 */
async function getPaymentMethod({
  client = db,
  requireEnabled = true,
} = {}) {
  const { rows } =
    await client.query(
      `
        SELECT
          id,
          provider,
          asset,
          network,
          display_name,

          deposit_address,
          destination_tag,

          minimum_amount_usd,
          maximum_amount_usd,

          required_confirmations,
          display_order,

          is_enabled,
          is_primary,

          settings,
          created_at,
          updated_at

        FROM crypto_payment_methods

        WHERE provider = $1
          AND asset = 'USDT'
          AND network = 'BINANCE_PAY'

        LIMIT 1
      `,
      [PROVIDER]
    );

  const method =
    rows[0] || null;

  if (!method) {
    throw new Error(
      "binance_pay_method_missing"
    );
  }

  if (
    requireEnabled &&
    !method.is_enabled
  ) {
    throw new Error(
      "binance_pay_method_disabled"
    );
  }

  if (
    requireEnabled &&
    (
      typeof method
        .deposit_address !==
        "string" ||
      !method
        .deposit_address
        .trim()
    )
  ) {
    throw new Error(
      "binance_pay_recipient_missing"
    );
  }

  return method;
}

async function listEnabledMethods() {
  const providerConfig =
    await getProviderConfig();

  const method =
    await getPaymentMethod();

  return {
    provider: {
      code:
        providerConfig.provider,

      displayName:
        providerConfig.display_name,

      minimumAmountUsd:
        providerConfig
          .minimum_amount_usd,

      maximumAmountUsd:
        providerConfig
          .maximum_amount_usd,
    },

    methods: [
      {
        id: method.id,

        provider:
          method.provider,

        asset:
          method.asset,

        network:
          method.network,

        displayName:
          method.display_name,

        minimumAmountUsd:
          method.minimum_amount_usd,

        maximumAmountUsd:
          method.maximum_amount_usd,

        isPrimary:
          method.is_primary,

        settings:
          method.settings,
      },
    ],
  };
}

/**
 * Binance Pay payment order।
 *
 * Normal flow:
 * 1. Order তৈরি
 * 2. Recipient/Pay ID দেখানো
 * 3. User payment করে
 * 4. User Binance transaction ID submit করে
 * 5. Worker official transaction history দিয়ে verify করে
 */
async function createBinancePayOrder({
  userId,
  amountUsd,
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

  const client =
    await db.getClient();

  try {
    await client.query("BEGIN");

    const providerConfig =
      await getProviderConfig({
        client,
      });

    const paymentMethod =
      await getPaymentMethod({
        client,
      });

    const minimumAmountUsd =
      Math.max(
        Number(
          providerConfig
            .minimum_amount_usd
        ),
        Number(
          paymentMethod
            .minimum_amount_usd
        )
      );

    const maximumAmountUsd =
      Math.min(
        Number(
          providerConfig
            .maximum_amount_usd
        ),
        Number(
          paymentMethod
            .maximum_amount_usd
        )
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
                "USDT",

              network:
                "BINANCE_PAY",

              expectedCryptoAmount:
                normalizedAmountUsd
                  .toFixed(8),

              destinationAddress:
                paymentMethod
                  .deposit_address
                  .trim(),

              destinationTag:
                paymentMethod
                  .destination_tag,

              status:
                PAYMENT_STATUSES
                  .AWAITING_PAYMENT,

              expiresAt,

              metadata: {
                ...(metadata || {}),

                payment_method_id:
                  paymentMethod.id,

                transaction_id_required:
                  true,

                engine_version:
                  "payment-engine-v1",

                provider_mode:
                  "binance_pay",
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
            crypto_payment_method_id =
              $2,

            verification_attempts = 0,

            /*
             * Transaction ID submit না করা পর্যন্ত
             * worker যেন খুব দ্রুত বারবার query না করে।
             */
            next_verification_at =
              NOW() +
              INTERVAL '30 seconds',

            updated_at = NOW()

          WHERE id = $1

          RETURNING *
        `,
        [
          order.id,
          paymentMethod.id,
        ]
      );

    order =
      updatedResult.rows[0];

    await paymentHistoryService
      .recordOrderCreated({
        order,
        client,
      });

    await paymentHistoryService
      .recordCryptoEvent({
        paymentOrderId:
          order.id,

        userId:
          order.user_id,

        provider:
          order.provider,

        eventType:
          "awaiting_payment",

        providerEventId:
          order.order_reference,

        orderStatus:
          order.status,

        asset:
          order.asset,

        network:
          order.network,

        cryptoAmount:
          order.expected_crypto_amount,

        usdAmount:
          order.requested_amount_usd,

        amountMicroUsd:
          order
            .requested_amount_microusd,

        toAddress:
          order.destination_address,

        verificationResult:
          "pending",

        note:
          "Awaiting Binance Pay transfer and transaction ID",

        rawPayload: {
          paymentMethodId:
            paymentMethod.id,

          transactionIdRequired:
            true,

          expiresAt:
            order.expires_at,
        },

        client,
      });

    const queueJob =
      await reconciliationRepository
        .enqueueJob({
          paymentOrderId:
            order.id,

          provider:
            PROVIDER,

          priority:
            Number(
              providerConfig.priority
            ),

          maxAttempts:
            Number(
              providerConfig
                .max_retry_attempts
            ),

          nextAttemptAt:
            new Date(
              Date.now() +
                30 * 1000
            ),

          client,
        });

    const finalOrder =
      await paymentRepository
        .getPaymentOrderById(
          order.id,
          client
        );

    await client.query("COMMIT");

    return {
      success: true,

      provider:
        PROVIDER,

      order: {
        id:
          finalOrder.id,

        orderReference:
          finalOrder
            .order_reference,

        status:
          finalOrder.status,

        amountUsd:
          finalOrder
            .requested_amount_usd,

        amountMicroUsd:
          finalOrder
            .requested_amount_microusd,

        asset:
          finalOrder.asset,

        network:
          finalOrder.network,

        paymentAmount:
          finalOrder
            .expected_crypto_amount,

        recipient:
          finalOrder
            .destination_address,

        recipientType:
          normalizeOptionalText(
            paymentMethod
              .settings
              ?.recipient_type,
            50
          ) || "binance_pay",

        transactionIdRequired:
          true,

        expiresAt:
          finalOrder.expires_at,

        createdAt:
          finalOrder.created_at,
      },

      reconciliation: {
        jobId:
          queueJob.id,

        status:
          queueJob.job_status,
      },
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

/**
 * User Binance Pay transaction ID submit করে।
 *
 * এটি নিজে payment verify বা wallet credit করে না।
 * Worker পরে official Binance history-এর সঙ্গে মিলাবে।
 */
async function submitBinancePayTransactionId({
  userId,
  orderReference,
  transactionId,
}) {
  const normalizedUserId =
    normalizePositiveId(
      userId,
      "user_id"
    );

  const normalizedReference =
    normalizeOptionalText(
      orderReference,
      80
    );

  const normalizedTransactionId =
    normalizeOptionalText(
      transactionId,
      500
    );

  if (!normalizedReference) {
    throw new Error(
      "order_reference_required"
    );
  }

  if (
    !normalizedTransactionId ||
    normalizedTransactionId
      .length < 6
  ) {
    throw new Error(
      "invalid_binance_pay_transaction_id"
    );
  }

  const client =
    await db.getClient();

  try {
    await client.query("BEGIN");

    const orderResult =
      await client.query(
        `
          SELECT *
          FROM payment_orders

          WHERE order_reference = $1
            AND user_id = $2
            AND provider = $3

          FOR UPDATE
        `,
        [
          normalizedReference,
          normalizedUserId,
          PROVIDER,
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
        .findOrderByProviderTransactionId({
          provider:
            PROVIDER,

          providerTransactionId:
            normalizedTransactionId,

          client,
        });

    if (
      duplicateOrder &&
      Number(duplicateOrder.id) !==
        Number(order.id)
    ) {
      throw new Error(
        "provider_transaction_already_used"
      );
    }

    const updatedOrder =
      await paymentRepository
        .updatePaymentOrder({
          orderId:
            order.id,

          providerTransactionId:
            normalizedTransactionId,

          status:
            PAYMENT_STATUSES
              .PAYMENT_DETECTED,

          paymentDetectedAt:
            new Date(),

          client,
        });

    await paymentHistoryService
      .recordCryptoEvent({
        paymentOrderId:
          updatedOrder.id,

        userId:
          updatedOrder.user_id,

        provider:
          updatedOrder.provider,

        eventType:
          "tx_submitted",

        providerEventId:
          normalizedTransactionId,

        orderStatus:
          updatedOrder.status,

        asset:
          updatedOrder.asset,

        network:
          updatedOrder.network,

        cryptoAmount:
          updatedOrder
            .expected_crypto_amount,

        usdAmount:
          updatedOrder
            .requested_amount_usd,

        amountMicroUsd:
          updatedOrder
            .requested_amount_microusd,

        providerTransactionId:
          normalizedTransactionId,

        verificationResult:
          "pending",

        note:
          "Binance Pay transaction ID submitted",

        rawPayload: {
          submittedByUser:
            normalizedUserId,
        },

        client,
      });

    await reconciliationRepository
      .enqueueJob({
        paymentOrderId:
          updatedOrder.id,

        provider:
          PROVIDER,

        priority:
          20,

        maxAttempts:
          20,

        nextAttemptAt:
          new Date(),

        client,
      });

    await client.query("COMMIT");

    return updatedOrder;
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
  getPaymentMethod,
  listEnabledMethods,

  createBinancePayOrder,
  submitBinancePayTransactionId,
};