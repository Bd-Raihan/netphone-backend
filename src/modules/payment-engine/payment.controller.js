"use strict";

const providers = require("./providers");

const paymentOrderService = require(
  "./payment.order.service"
);

const {
  PAYMENT_PROVIDERS,
} = require("./payment.constants");

function sendError(
  res,
  error,
  where = "payment_controller"
) {
  console.error(
    `PAYMENT ENGINE ERROR [${where}]`,
    error
  );

  const message =
    error?.message ||
    "payment_engine_error";

  const clientErrors = new Set([
    "payment_provider_required",
    "unsupported_payment_provider",
    "invalid_user_id",
    "invalid_recharge_amount_usd",
    "asset_required",
    "network_required",
    "order_reference_required",
    "invalid_transaction_hash",
    "invalid_binance_pay_transaction_id",
    "payment_order_not_found",
    "payment_order_already_finalized",
    "transaction_hash_already_used",
    "provider_transaction_already_used",
    "binance_onchain_disabled",
    "binance_pay_disabled",
    "manual_crypto_disabled",
    "crypto_payment_method_disabled",
    "binance_pay_method_disabled",
  ]);

  let statusCode = 500;

  if (
    message.includes(
      "recharge_amount_must_be_between"
    ) ||
    clientErrors.has(message) ||
    message.startsWith(
      "unsupported_payment_provider:"
    )
  ) {
    statusCode = 400;
  }

  if (
    message ===
    "payment_order_not_found"
  ) {
    statusCode = 404;
  }

  return res.status(statusCode).json({
    ok: false,
    message,
  });
}

function getAuthenticatedUserId(req) {
  const userId =
    Number(req.user?.id);

  if (
    !Number.isInteger(userId) ||
    userId <= 0
  ) {
    throw new Error(
      "invalid_user_id"
    );
  }

  return userId;
}

/**
 * GET /api/payment-engine/providers
 *
 * Registered capabilities দেখাবে।
 * Secret, recipient বা address দেখাবে না।
 */
async function listProviders(
  req,
  res
) {
  try {
    return res.json({
      ok: true,

      providers:
        providers
          .listProviderCapabilities(),
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "listProviders"
    );
  }
}

/**
 * GET /api/payment-engine/methods/:provider
 *
 * Enabled dynamic methods/network list।
 */
async function listMethods(
  req,
  res
) {
  try {
    const provider =
      req.params.provider;

    const result =
      await providers
        .listEnabledMethods(
          provider
        );

    return res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "listMethods"
    );
  }
}

/**
 * POST /api/payment-engine/orders
 *
 * Binance On-chain:
 * {
 *   provider: "binance_onchain",
 *   amountUsd: 10,
 *   asset: "USDT",
 *   network: "TRC20"
 * }
 *
 * Binance Pay:
 * {
 *   provider: "binance_pay",
 *   amountUsd: 10
 * }
 *
 * Manual fallback:
 * {
 *   provider: "manual_crypto",
 *   amountUsd: 10,
 *   asset: "USDT",
 *   network: "TRC20",
 *   txHash: "...",
 *   walletAddress: "...",
 *   note: "..."
 * }
 */
async function createOrder(
  req,
  res
) {
  try {
    const userId =
      getAuthenticatedUserId(req);

    const {
      provider,
      amountUsd,

      asset,
      network,

      quotedCryptoAmount,

      txHash,
      walletAddress,
      note,
    } = req.body || {};

    const normalizedProvider =
      providers
        .normalizeProviderName(
          provider
        );

    let payload;

    switch (
      normalizedProvider
    ) {
      case PAYMENT_PROVIDERS
        .BINANCE_ONCHAIN:
        payload = {
          userId,
          amountUsd,
          asset,
          network,
          quotedCryptoAmount,

          metadata: {
            source:
              "payment_engine_api",

            ip:
              req.ip || null,

            userAgent:
              req.headers[
                "user-agent"
              ] || null,
          },
        };
        break;

      case PAYMENT_PROVIDERS
        .BINANCE_PAY:
        payload = {
          userId,
          amountUsd,

          metadata: {
            source:
              "payment_engine_api",

            ip:
              req.ip || null,

            userAgent:
              req.headers[
                "user-agent"
              ] || null,
          },
        };
        break;

      case PAYMENT_PROVIDERS
        .MANUAL_CRYPTO:
        payload = {
          userId,
          amountUsd,
          asset,
          network,
          txHash,
          walletAddress,
          note,

          metadata: {
            source:
              "payment_engine_api",

            ip:
              req.ip || null,

            userAgent:
              req.headers[
                "user-agent"
              ] || null,
          },
        };
        break;

      default:
        throw new Error(
          `unsupported_payment_provider:${normalizedProvider}`
        );
    }

    const result =
      await providers.createOrder({
        provider:
          normalizedProvider,

        payload,
      });

    return res
      .status(201)
      .json({
        ok: true,
        data: result,
      });
  } catch (error) {
    return sendError(
      res,
      error,
      "createOrder"
    );
  }
}

/**
 * GET /api/payment-engine/orders
 */
async function listMyOrders(
  req,
  res
) {
  try {
    const userId =
      getAuthenticatedUserId(req);

    const limit =
      req.query.limit;

    const offset =
      req.query.offset;

    const orders =
      await paymentOrderService
        .listUserOrders({
          userId,
          limit,
          offset,
        });

    return res.json({
      ok: true,
      orders,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "listMyOrders"
    );
  }
}

/**
 * GET /api/payment-engine/orders/:reference
 */
async function getMyOrder(
  req,
  res
) {
  try {
    const userId =
      getAuthenticatedUserId(req);

    const order =
      await paymentOrderService
        .getUserOrder({
          userId,

          orderReference:
            req.params.reference,
        });

    return res.json({
      ok: true,
      order,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "getMyOrder"
    );
  }
}

/**
 * GET /api/payment-engine/history
 *
 * Dedicated Crypto Transaction History।
 */
async function listMyCryptoHistory(
  req,
  res
) {
  try {
    const userId =
      getAuthenticatedUserId(req);

    const history =
      await paymentOrderService
        .listUserCryptoHistory({
          userId,

          limit:
            req.query.limit,

          offset:
            req.query.offset,
        });

    return res.json({
      ok: true,
      history,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "listMyCryptoHistory"
    );
  }
}

/**
 * POST /api/payment-engine/orders/:reference/tx-hash
 *
 * Binance On-chain order-এর TXID submit।
 */
async function submitTxHash(
  req,
  res
) {
  try {
    const userId =
      getAuthenticatedUserId(req);

    const order =
      await paymentOrderService
        .submitTransactionHash({
          userId,

          orderReference:
            req.params.reference,

          txHash:
            req.body?.txHash,
        });

    return res.json({
      ok: true,
      order,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "submitTxHash"
    );
  }
}

/**
 * POST /api/payment-engine/orders/:reference/binance-pay-transaction
 */
async function submitBinancePayTransaction(
  req,
  res
) {
  try {
    const userId =
      getAuthenticatedUserId(req);

    const provider =
      providers.getProvider(
        PAYMENT_PROVIDERS
          .BINANCE_PAY
      );

    const order =
      await provider
        .submitBinancePayTransactionId({
          userId,

          orderReference:
            req.params.reference,

          transactionId:
            req.body?.transactionId,
        });

    return res.json({
      ok: true,
      order,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "submitBinancePayTransaction"
    );
  }
}

module.exports = {
  listProviders,
  listMethods,

  createOrder,

  listMyOrders,
  getMyOrder,

  listMyCryptoHistory,

  submitTxHash,
  submitBinancePayTransaction,
};