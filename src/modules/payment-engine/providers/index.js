"use strict";

const {
  PAYMENT_PROVIDERS,
} = require("../payment.constants");

const binanceOnchainProvider = require(
  "./binance-onchain/binance.onchain.service"
);

const binancePayProvider = require(
  "./binance-pay/binance.pay.service"
);

const manualCryptoProvider = require(
  "./manual-crypto/manual.crypto.service"
);

/**
 * NetPhone Payment Provider Registry
 *
 * বর্তমান scope:
 * 1. Binance On-chain — Primary
 * 2. Binance Pay      — Secondary
 * 3. Manual Crypto    — Fallback review
 *
 * Controller বা অন্য service সরাসরি provider file import করবে না।
 * সব provider এই registry দিয়ে resolve হবে।
 */
const providerRegistry = Object.freeze({
  [PAYMENT_PROVIDERS.BINANCE_ONCHAIN]:
    binanceOnchainProvider,

  [PAYMENT_PROVIDERS.BINANCE_PAY]:
    binancePayProvider,

  [PAYMENT_PROVIDERS.MANUAL_CRYPTO]:
    manualCryptoProvider,
});

/**
 * Provider name normalize করে।
 */
function normalizeProviderName(value) {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new Error(
      "payment_provider_required"
    );
  }

  return value
    .trim()
    .toLowerCase();
}

/**
 * Provider registered আছে কিনা।
 */
function hasProvider(providerName) {
  if (
    typeof providerName !== "string" ||
    !providerName.trim()
  ) {
    return false;
  }

  const normalizedName =
    providerName
      .trim()
      .toLowerCase();

  return Object.prototype
    .hasOwnProperty.call(
      providerRegistry,
      normalizedName
    );
}

/**
 * Registered provider resolve করে।
 */
function getProvider(providerName) {
  const normalizedName =
    normalizeProviderName(
      providerName
    );

  const provider =
    providerRegistry[
      normalizedName
    ];

  if (!provider) {
    throw new Error(
      `unsupported_payment_provider:${normalizedName}`
    );
  }

  return provider;
}

/**
 * Registered provider code list।
 */
function listProviders() {
  return Object.keys(
    providerRegistry
  );
}

/**
 * Provider metadata।
 *
 * এখানে secret, API key বা Binance recipient থাকবে না।
 */
function listProviderCapabilities() {
  return [
    {
      code:
        PAYMENT_PROVIDERS
          .BINANCE_ONCHAIN,

      role:
        "primary",

      automatic:
        true,

      createFunction:
        "createOnchainOrder",

      submissionFunction:
        "submitTransactionHash",
    },

    {
      code:
        PAYMENT_PROVIDERS
          .BINANCE_PAY,

      role:
        "secondary",

      automatic:
        true,

      createFunction:
        "createBinancePayOrder",

      submissionFunction:
        "submitBinancePayTransactionId",
    },

    {
      code:
        PAYMENT_PROVIDERS
          .MANUAL_CRYPTO,

      role:
        "fallback",

      automatic:
        false,

      createFunction:
        "createManualReviewOrder",

      submissionFunction:
        null,
    },
  ];
}

/**
 * Provider-specific order creation dispatch।
 */
async function createOrder({
  provider,
  payload,
}) {
  const normalizedProvider =
    normalizeProviderName(
      provider
    );

  const providerService =
    getProvider(
      normalizedProvider
    );

  switch (normalizedProvider) {
    case PAYMENT_PROVIDERS
      .BINANCE_ONCHAIN:
      return providerService
        .createOnchainOrder(
          payload
        );

    case PAYMENT_PROVIDERS
      .BINANCE_PAY:
      return providerService
        .createBinancePayOrder(
          payload
        );

    case PAYMENT_PROVIDERS
      .MANUAL_CRYPTO:
      return providerService
        .createManualReviewOrder(
          payload
        );

    default:
      throw new Error(
        `unsupported_payment_provider:${normalizedProvider}`
      );
  }
}

/**
 * Enabled methods provider অনুযায়ী load করে।
 */
async function listEnabledMethods(
  providerName
) {
  const normalizedProvider =
    normalizeProviderName(
      providerName
    );

  const providerService =
    getProvider(
      normalizedProvider
    );

  if (
    typeof providerService
      .listEnabledMethods !==
    "function"
  ) {
    return {
      provider: {
        code:
          normalizedProvider,
      },

      methods: [],
    };
  }

  return providerService
    .listEnabledMethods();
}

module.exports = {
  providerRegistry,

  normalizeProviderName,

  hasProvider,
  getProvider,

  listProviders,
  listProviderCapabilities,
  listEnabledMethods,

  createOrder,
};