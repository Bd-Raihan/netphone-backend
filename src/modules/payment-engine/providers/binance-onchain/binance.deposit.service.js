"use strict";

const Decimal =
  global.Decimal || null;

const db = require(
  "../../../../config/db"
);

const binanceClient = require(
  "./binance.client"
);

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
  PAYMENT_STATUSES,
} = require(
  "../../payment.constants"
);

const PROVIDER =
  PAYMENT_PROVIDERS.BINANCE_ONCHAIN;

const SUCCESS_DEPOSIT_STATUS = 1;

function normalizePositiveId(
  value,
  fieldName = "id"
) {
  const normalized =
    Number(value);

  if (
    !Number.isInteger(
      normalized
    ) ||
    normalized <= 0
  ) {
    throw new Error(
      `invalid_${fieldName}`
    );
  }

  return normalized;
}

function normalizeText(
  value,
  {
    uppercase = false,
    maxLength = 1000,
  } = {}
) {
  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  let normalized =
    String(value).trim();

  if (!normalized) {
    return null;
  }

  if (uppercase) {
    normalized =
      normalized.toUpperCase();
  }

  return normalized.slice(
    0,
    maxLength
  );
}

function normalizeNetwork(
  value
) {
  const normalized =
    normalizeText(value, {
      uppercase: true,
      maxLength: 40,
    });

  if (!normalized) {
    return null;
  }

  const aliases = {
    TRX: "TRC20",
    TRON: "TRC20",
    "TRON(TRC20)": "TRC20",

    BSC: "BEP20",
    "BSC(BEP20)": "BEP20",
    "BNB SMART CHAIN": "BEP20",

    BTC: "BTC",
    BITCOIN: "BTC",

    LTC: "LTC",
    LITECOIN: "LTC",

    ETH: "ERC20",
    ETHEREUM: "ERC20",
    ERC20: "ERC20",
  };

  return (
    aliases[normalized] ||
    normalized
  );
}

function normalizeAmountString(
  value
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const normalized =
    String(value).trim();

  if (
    !/^\d+(\.\d+)?$/.test(
      normalized
    )
  ) {
    return null;
  }

  return normalized;
}

function decimalToScaledInteger(
  value,
  scale = 18
) {
  const normalized =
    normalizeAmountString(
      value
    );

  if (!normalized) {
    throw new Error(
      "invalid_decimal_amount"
    );
  }

  const [
    wholePart,
    decimalPart = "",
  ] = normalized.split(".");

  const paddedDecimals =
    decimalPart
      .padEnd(scale, "0")
      .slice(0, scale);

  return (
    BigInt(wholePart) *
      10n ** BigInt(scale) +
    BigInt(
      paddedDecimals || "0"
    )
  );
}

function amountsAreEqual(
  expected,
  actual,
  {
    tolerance =
      "0.00000001",
    scale = 18,
  } = {}
) {
  const expectedScaled =
    decimalToScaledInteger(
      expected,
      scale
    );

  const actualScaled =
    decimalToScaledInteger(
      actual,
      scale
    );

  const toleranceScaled =
    decimalToScaledInteger(
      tolerance,
      scale
    );

  const difference =
    expectedScaled >=
    actualScaled
      ? expectedScaled -
        actualScaled
      : actualScaled -
        expectedScaled;

  return (
    difference <=
    toleranceScaled
  );
}

function parseConfirmations(
  deposit
) {
  const confirmTimes =
    normalizeText(
      deposit?.confirmTimes,
      {
        maxLength: 100,
      }
    );

  /*
   * Binance may return values such as:
   * "12/12"
   */
  if (
    confirmTimes &&
    confirmTimes.includes("/")
  ) {
    const [
      current,
      required,
    ] = confirmTimes
      .split("/")
      .map((item) =>
        Number(item)
      );

    return {
      current:
        Number.isFinite(current)
          ? current
          : null,

      required:
        Number.isFinite(required)
          ? required
          : null,

      raw:
        confirmTimes,
    };
  }

  const unlockConfirm =
    Number(
      deposit?.unlockConfirm
    );

  return {
    current:
      Number.isFinite(
        unlockConfirm
      )
        ? unlockConfirm
        : null,

    required:
      null,

    raw:
      confirmTimes,
  };
}

function normalizeDeposit(
  deposit
) {
  if (
    !deposit ||
    typeof deposit !==
      "object"
  ) {
    return null;
  }

  const confirmations =
    parseConfirmations(
      deposit
    );

  return {
    providerDepositId:
      normalizeText(
        deposit.id,
        {
          maxLength: 500,
        }
      ),

    txHash:
      normalizeText(
        deposit.txId ||
          deposit.txHash,
        {
          maxLength: 500,
        }
      ),

    coin:
      normalizeText(
        deposit.coin,
        {
          uppercase: true,
          maxLength: 20,
        }
      ),

    network:
      normalizeNetwork(
        deposit.network
      ),

    amount:
      normalizeAmountString(
        deposit.amount
      ),

    address:
      normalizeText(
        deposit.address,
        {
          maxLength: 1000,
        }
      ),

    addressTag:
      normalizeText(
        deposit.addressTag,
        {
          maxLength: 500,
        }
      ),

    status:
      Number(
        deposit.status
      ),

    insertTime:
      Number(
        deposit.insertTime
      ),

    transferType:
      deposit.transferType ??
      null,

    walletType:
      deposit.walletType ??
      null,

    confirmations:
      confirmations.current,

    requiredConfirmations:
      confirmations.required,

    confirmTimes:
      confirmations.raw,

    travelRuleStatus:
      deposit.travelRuleStatus ??
      null,

    unlockConfirm:
      deposit.unlockConfirm ??
      null,

    raw:
      deposit,
  };
}

function txHashesEqual(
  first,
  second
) {
  const normalizedFirst =
    normalizeText(first, {
      maxLength: 500,
    });

  const normalizedSecond =
    normalizeText(second, {
      maxLength: 500,
    });

  if (
    !normalizedFirst ||
    !normalizedSecond
  ) {
    return false;
  }

  return (
    normalizedFirst
      .toLowerCase() ===
    normalizedSecond
      .toLowerCase()
  );
}

function addressesEqual(
  first,
  second
) {
  const normalizedFirst =
    normalizeText(first, {
      maxLength: 1000,
    });

  const normalizedSecond =
    normalizeText(second, {
      maxLength: 1000,
    });

  if (
    !normalizedFirst ||
    !normalizedSecond
  ) {
    return false;
  }

  return (
    normalizedFirst
      .toLowerCase() ===
    normalizedSecond
      .toLowerCase()
  );
}

function validateDepositAgainstOrder({
  order,
  deposit,
  requiredConfirmations = null,
}) {
  const failures = [];

  if (!deposit) {
    failures.push(
      "deposit_missing"
    );

    return {
      valid: false,
      final: false,
      failures,
    };
  }

  if (
    !txHashesEqual(
      order.tx_hash,
      deposit.txHash
    )
  ) {
    failures.push(
      "tx_hash_mismatch"
    );
  }

  if (
    normalizeText(
      order.asset,
      {
        uppercase: true,
        maxLength: 20,
      }
    ) !== deposit.coin
  ) {
    failures.push(
      "coin_mismatch"
    );
  }

  if (
    normalizeNetwork(
      order.network
    ) !==
    deposit.network
  ) {
    failures.push(
      "network_mismatch"
    );
  }

  if (
    !addressesEqual(
      order.destination_address,
      deposit.address
    )
  ) {
    failures.push(
      "deposit_address_mismatch"
    );
  }

  if (
    order.destination_tag
  ) {
    const expectedTag =
      normalizeText(
        order.destination_tag,
        {
          maxLength: 500,
        }
      );

    const actualTag =
      normalizeText(
        deposit.addressTag,
        {
          maxLength: 500,
        }
      );

    if (
      expectedTag !== actualTag
    ) {
      failures.push(
        "destination_tag_mismatch"
      );
    }
  }

  if (
    !deposit.amount ||
    !order.expected_crypto_amount
  ) {
    failures.push(
      "deposit_amount_missing"
    );
  } else if (
    !amountsAreEqual(
      order.expected_crypto_amount,
      deposit.amount
    )
  ) {
    failures.push(
      "amount_mismatch"
    );
  }

  if (
    deposit.status !==
    SUCCESS_DEPOSIT_STATUS
  ) {
    failures.push(
      "deposit_not_successful"
    );
  }

  const finalRequiredConfirmations =
    requiredConfirmations ??
    deposit.requiredConfirmations ??
    1;

  const confirmationPending =
    Number.isFinite(
      deposit.confirmations
    ) &&
    Number(
      deposit.confirmations
    ) <
      Number(
        finalRequiredConfirmations
      );

  if (confirmationPending) {
    failures.push(
      "confirmations_pending"
    );
  }

  const permanentFailures =
    failures.filter(
      (failure) =>
        ![
          "deposit_not_successful",
          "confirmations_pending",
        ].includes(failure)
    );

  return {
    valid:
      failures.length === 0,

    final:
      permanentFailures.length >
        0,

    failures,

    confirmations:
      deposit.confirmations,

    requiredConfirmations:
      finalRequiredConfirmations,
  };
}

async function getPaymentMethodForOrder({
  order,
  client = db,
}) {
  if (
    !order
      .crypto_payment_method_id
  ) {
    return null;
  }

  const { rows } =
    await client.query(
      `
        SELECT *
        FROM crypto_payment_methods
        WHERE id = $1
        LIMIT 1
      `,
      [
        order
          .crypto_payment_method_id,
      ]
    );

  return rows[0] || null;
}

async function fetchDepositsForOrder(
  order
) {
  const orderCreatedAt =
    new Date(
      order.created_at
    ).getTime();

  const expiresAt =
    order.expires_at
      ? new Date(
          order.expires_at
        ).getTime()
      : Date.now();

  const startTime =
    Math.max(
      orderCreatedAt -
        10 * 60 * 1000,
      Date.now() -
        89 * 24 *
          60 *
          60 *
          1000
    );

  const endTime =
    Math.min(
      Math.max(
        expiresAt +
          24 * 60 *
            60 *
            1000,
        Date.now()
      ),
      Date.now()
    );

  const result =
    await binanceClient
      .getDepositHistory({
        coin:
          order.asset,

        startTime,
        endTime,

        limit: 1000,
      });

  return result.deposits
    .map(
      normalizeDeposit
    )
    .filter(Boolean);
}

function findDepositByTxHash({
  deposits,
  txHash,
}) {
  if (
    !Array.isArray(
      deposits
    )
  ) {
    return null;
  }

  return (
    deposits.find(
      (deposit) =>
        txHashesEqual(
          deposit.txHash,
          txHash
        )
    ) || null
  );
}

async function recordDepositDetected({
  order,
  deposit,
  requiredConfirmations,
  client,
}) {
  return paymentHistoryService
    .recordDepositDetected({
      order,

      providerEventId:
        deposit.providerDepositId ||
        deposit.txHash,

      providerTransactionId:
        deposit.providerDepositId,

      txHash:
        deposit.txHash,

      cryptoAmount:
        deposit.amount,

      confirmations:
        deposit.confirmations,

      requiredConfirmations,

      toAddress:
        deposit.address,

      rawPayload:
        deposit.raw,

      client,
    });
}

async function updateOrderAsConfirming({
  order,
  deposit,
  validation,
  client,
}) {
  const updatedOrder =
    await paymentRepository
      .updatePaymentOrder({
        orderId:
          order.id,

        status:
          PAYMENT_STATUSES
            .CONFIRMING,

        providerTransactionId:
          deposit.providerDepositId,

        txHash:
          deposit.txHash,

        paymentDetectedAt:
          order.payment_detected_at ||
          new Date(),

        metadata: {
          ...(order.metadata || {}),

          binance_deposit: {
            status:
              deposit.status,

            confirmations:
              deposit.confirmations,

            required_confirmations:
              validation
                .requiredConfirmations,

            last_checked_at:
              new Date()
                .toISOString(),
          },
        },

        client,
      });

  await paymentHistoryService
    .recordConfirmationUpdated({
      order:
        updatedOrder,

      providerEventId:
        deposit.providerDepositId ||
        deposit.txHash,

      txHash:
        deposit.txHash,

      confirmations:
        deposit.confirmations,

      requiredConfirmations:
        validation
          .requiredConfirmations,

      rawPayload:
        deposit.raw,

      client,
    });

  return updatedOrder;
}

async function incrementVerificationAttempt({
  orderId,
  nextVerificationAt,
  client,
}) {
  const { rows } =
    await client.query(
      `
        UPDATE payment_orders
        SET
          verification_attempts =
            verification_attempts + 1,

          last_verified_at =
            NOW(),

          next_verification_at =
            $2,

          updated_at =
            NOW()

        WHERE id = $1

        RETURNING *
      `,
      [
        orderId,
        nextVerificationAt,
      ]
    );

  return rows[0] || null;
}

async function verifyOrderDeposit({
  orderId,
}) {
  const normalizedOrderId =
    normalizePositiveId(
      orderId,
      "order_id"
    );

  const order =
    await paymentRepository
      .getPaymentOrderById(
        normalizedOrderId
      );

  if (!order) {
    throw new Error(
      "payment_order_not_found"
    );
  }

  if (
    order.provider !==
    PROVIDER
  ) {
    throw new Error(
      "payment_provider_mismatch"
    );
  }

  if (
    order.status ===
      PAYMENT_STATUSES
        .CREDITED
  ) {
    return {
      result:
        "already_credited",
      order,
    };
  }

  if (
    [
      PAYMENT_STATUSES
        .CANCELLED,
      PAYMENT_STATUSES
        .EXPIRED,
      PAYMENT_STATUSES
        .REJECTED,
      PAYMENT_STATUSES
        .FAILED,
    ].includes(order.status)
  ) {
    return {
      result:
        "finalized_without_credit",
      order,
    };
  }

  if (!order.tx_hash) {
    return {
      result:
        "awaiting_tx_hash",
      retryable: true,
      retryAfterSeconds: 30,
      order,
    };
  }

  const paymentMethod =
    await getPaymentMethodForOrder({
      order,
    });

  const requiredConfirmations =
    Number(
      paymentMethod
        ?.required_confirmations ??
        order.metadata
          ?.required_confirmations ??
        1
    );

  const deposits =
    await fetchDepositsForOrder(
      order
    );

  const deposit =
    findDepositByTxHash({
      deposits,
      txHash:
        order.tx_hash,
    });

  if (!deposit) {
    const nextVerificationAt =
      new Date(
        Date.now() +
          30 * 1000
      );

    await incrementVerificationAttempt({
      orderId:
        order.id,
      nextVerificationAt,
      client: db,
    });

    return {
      result:
        "deposit_not_found",
      retryable: true,
      retryAfterSeconds: 30,
      order,
    };
  }

  const validation =
    validateDepositAgainstOrder({
      order,
      deposit,
      requiredConfirmations,
    });

  const client =
    await db.getClient();

  try {
    await client.query(
      "BEGIN"
    );

    const lockedOrder =
      await paymentRepository
        .lockPaymentOrderById({
          orderId:
            order.id,
          client,
        });

    if (!lockedOrder) {
      throw new Error(
        "payment_order_not_found"
      );
    }

    await recordDepositDetected({
      order:
        lockedOrder,
      deposit,
      requiredConfirmations:
        validation
          .requiredConfirmations,
      client,
    });

    await incrementVerificationAttempt({
      orderId:
        lockedOrder.id,

      nextVerificationAt:
        validation.valid
          ? null
          : new Date(
              Date.now() +
                30 * 1000
            ),

      client,
    });

    if (validation.valid) {
      await client.query(
        "COMMIT"
      );

      /*
       * creditVerifiedPayment opens its own complete atomic transaction.
       * The verification transaction above has already committed.
       */
      const creditResult =
        await paymentOrderService
          .creditVerifiedPayment({
            orderId:
              lockedOrder.id,

            verifiedProvider:
              PROVIDER,

            providerTransactionId:
              deposit
                .providerDepositId,

            txHash:
              deposit.txHash,

            asset:
              deposit.coin,

            network:
              deposit.network,

            cryptoAmount:
              deposit.amount,

            confirmations:
              deposit.confirmations,

            requiredConfirmations:
              validation
                .requiredConfirmations,

            providerPayload:
              deposit.raw,

            verificationNote:
              "Binance deposit history verified",
          });

      return {
        result:
          "credited",

        retryable:
          false,

        deposit,

        validation,

        creditResult,
      };
    }

    if (
      validation.failures.includes(
        "confirmations_pending"
      ) ||
      validation.failures.includes(
        "deposit_not_successful"
      )
    ) {
      const confirmingOrder =
        await updateOrderAsConfirming({
          order:
            lockedOrder,
          deposit,
          validation,
          client,
        });

      await client.query(
        "COMMIT"
      );

      return {
        result:
          "confirming",

        retryable:
          true,

        retryAfterSeconds:
          30,

        order:
          confirmingOrder,

        deposit,

        validation,
      };
    }

    await paymentHistoryService
      .recordVerificationFailed({
        order:
          lockedOrder,

        providerEventId:
          deposit
            .providerDepositId,

        txHash:
          deposit.txHash,

        reason:
          validation
            .failures
            .join(","),

        rawPayload:
          deposit.raw,

        client,
      });

    await client.query(
      "COMMIT"
    );

    const reviewedOrder =
      await paymentOrderService
        .markPaymentForManualReview({
          orderId:
            lockedOrder.id,

          provider:
            PROVIDER,

          reason:
            validation
              .failures
              .join(","),

          providerPayload:
            deposit.raw,
        });

    return {
      result:
        "manual_review",

      retryable:
        false,

      order:
        reviewedOrder,

      deposit,

      validation,
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

async function testDepositAccess() {
  const result =
    await binanceClient
      .getDepositHistory({
        limit: 1,
      });

  return {
    ok: true,

    readable:
      Array.isArray(
        result.deposits
      ),

    sampleCount:
      result.deposits.length,

    rateLimit:
      result.rateLimit,
  };
}

module.exports = {
  PROVIDER,

  normalizeNetwork,
  normalizeDeposit,

  amountsAreEqual,
  txHashesEqual,
  addressesEqual,

  validateDepositAgainstOrder,

  fetchDepositsForOrder,
  findDepositByTxHash,

  verifyOrderDeposit,

  testDepositAccess,
};