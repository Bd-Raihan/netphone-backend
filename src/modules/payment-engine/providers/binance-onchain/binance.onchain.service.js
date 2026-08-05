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
  PAYMENT_PROVIDERS.BINANCE_ONCHAIN;

/**
 * PostgreSQL BIGINT/ID validation.
 */
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

/**
 * USD recharge amount validation.
 */
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

/**
 * Asset/network values normalize.
 */
function normalizeCode(
  value,
  fieldName,
  maxLength = 40
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
    .toUpperCase()
    .slice(0, maxLength);
}

/**
 * Crypto amount normalize.
 *
 * USDT order-এর ক্ষেত্রে USD amount-এর সঙ্গে
 * 1:1 expected amount ব্যবহার করা হবে।
 *
 * BTC/LTC-এর মতো volatile asset-এর জন্য পরে
 * Binance public quote service verified quote পাঠাবে।
 */
function resolveExpectedCryptoAmount({
  asset,
  amountUsd,
  quotedCryptoAmount = null,
}) {
  if (quotedCryptoAmount !== null) {
    const quoted = Number(
      quotedCryptoAmount
    );

    if (
      !Number.isFinite(quoted) ||
      quoted <= 0
    ) {
      throw new Error(
        "invalid_crypto_quote"
      );
    }

    return quoted.toFixed(18);
  }

  if (asset === "USDT") {
    return Number(amountUsd)
      .toFixed(8);
  }

  throw new Error(
    "crypto_quote_required_for_asset"
  );
}

/**
 * Binance On-chain provider runtime config.
 */
async function getProviderConfig({
  client = db,
  requireEnabled = true,
} = {}) {
  const { rows } = await client.query(
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

  const config = rows[0] || null;

  if (!config) {
    throw new Error(
      "binance_onchain_config_missing"
    );
  }

  if (
    requireEnabled &&
    !config.is_enabled
  ) {
    throw new Error(
      "binance_onchain_disabled"
    );
  }

  if (!config.is_automatic) {
    throw new Error(
      "binance_onchain_not_automatic"
    );
  }

  return config;
}

/**
 * Enabled asset/network method load.
 *
 * Address Flutter-এ hard-code হবে না।
 */
async function getPaymentMethod({
  asset,
  network,
  client = db,
  requireEnabled = true,
}) {
  const normalizedAsset =
    normalizeCode(
      asset,
      "asset",
      20
    );

  const normalizedNetwork =
    normalizeCode(
      network,
      "network",
      40
    );

  const { rows } = await client.query(
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
        AND asset = $2
        AND network = $3

      LIMIT 1
    `,
    [
      PROVIDER,
      normalizedAsset,
      normalizedNetwork,
    ]
  );

  const method = rows[0] || null;

  if (!method) {
    throw new Error(
      "crypto_payment_method_not_found"
    );
  }

  if (
    requireEnabled &&
    !method.is_enabled
  ) {
    throw new Error(
      "crypto_payment_method_disabled"
    );
  }

  if (
    requireEnabled &&
    (
      typeof method.deposit_address !==
        "string" ||
      !method.deposit_address.trim()
    )
  ) {
    throw new Error(
      "crypto_deposit_address_missing"
    );
  }

  return method;
}

/**
 * App-এ দেখানোর জন্য enabled Binance On-chain methods.
 */
async function listEnabledMethods() {
  const providerConfig =
    await getProviderConfig();

  const { rows } = await db.query(
    `
      SELECT
        id,
        provider,
        asset,
        network,

        display_name,

        minimum_amount_usd,
        maximum_amount_usd,

        required_confirmations,
        display_order,

        is_primary,

        settings

      FROM crypto_payment_methods

      WHERE provider = $1
        AND is_enabled = TRUE
        AND deposit_address IS NOT NULL
        AND BTRIM(deposit_address) <> ''

      ORDER BY
        is_primary DESC,
        display_order ASC,
        id ASC
    `,
    [PROVIDER]
  );

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

    methods: rows,
  };
}

/**
 * Primary Binance On-chain payment order create.
 *
 * একটি transaction-এর মধ্যে:
 * - payment order
 * - crypto history
 * - reconciliation queue
 * তৈরি হয়।
 */
async function createOnchainOrder({
  userId,
  amountUsd,
  asset,
  network,

  quotedCryptoAmount = null,

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
    normalizeCode(
      asset,
      "asset",
      20
    );

  const normalizedNetwork =
    normalizeCode(
      network,
      "network",
      40
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
        asset:
          normalizedAsset,

        network:
          normalizedNetwork,

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

    const expectedCryptoAmount =
      resolveExpectedCryptoAmount({
        asset:
          normalizedAsset,

        amountUsd:
          normalizedAmountUsd,

        quotedCryptoAmount,
      });

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

    /*
     * Extremely rare reference collision protection.
     */
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

              expectedCryptoAmount,

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

                required_confirmations:
                  paymentMethod
                    .required_confirmations,

                engine_version:
                  "payment-engine-v1",

                provider_mode:
                  "binance_onchain",
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

    /*
     * Migration 020 runtime fields update.
     */
    const updatedOrderResult =
      await client.query(
        `
          UPDATE payment_orders

          SET
            crypto_payment_method_id = $2,

            next_verification_at =
              NOW(),

            verification_attempts = 0,

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
      updatedOrderResult.rows[0];

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
          order.requested_amount_microusd,

        toAddress:
          order.destination_address,

        verificationResult:
          "pending",

        note:
          "Awaiting Binance On-chain deposit",

        rawPayload: {
          paymentMethodId:
            paymentMethod.id,

          requiredConfirmations:
            paymentMethod
              .required_confirmations,

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
            new Date(),

          client,
        });

    /*
     * enqueueJob order-এর reconciliation_job_id
     * এবং next_verification_at update করে।
     */
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

        cryptoAmount:
          finalOrder
            .expected_crypto_amount,

        address:
          finalOrder
            .destination_address,

        destinationTag:
          finalOrder
            .destination_tag,

        requiredConfirmations:
          paymentMethod
            .required_confirmations,

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

module.exports = {
  PROVIDER,

  getProviderConfig,
  getPaymentMethod,
  listEnabledMethods,

  createOnchainOrder,
};