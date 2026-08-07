"use strict";

/**
 * NetPhone Binance Dynamic Crypto Quote Service
 * ------------------------------------------------------------
 *
 * Purpose:
 * - Convert recharge USD amount into expected crypto amount
 * - BTC / LTC / SOL / ETH-এর live Binance market price ব্যবহার
 * - Quote client/Flutter থেকে trust না করে backend থেকে generate
 *
 * Quote source:
 * Binance public ticker endpoint
 *
 * Example:
 * BTCUSDT price = 120000
 * Recharge USD  = 5
 *
 * Expected BTC:
 * 5 / 120000 = 0.00004167 BTC
 */

const binanceClient = require(
  "./binance.client"
);

/**
 * বর্তমানে NetPhone-এ supported volatile assets.
 *
 * USDT এখানে রাখা হয়নি কারণ USDT payment-এর existing
 * 1:1 USD handling আলাদা আছে।
 */
const SUPPORTED_QUOTE_ASSETS =
  Object.freeze([
    "BTC",
    "LTC",
    "SOL",
    "ETH",
  ]);

/**
 * Binance trading pairs.
 *
 * NetPhone wallet accounting USD-তে হলেও crypto quote-এর
 * market reference হিসেবে liquid USDT pair ব্যবহার করা হবে।
 */
const ASSET_SYMBOL_MAP =
  Object.freeze({
    BTC: "BTCUSDT",
    LTC: "LTCUSDT",
    SOL: "SOLUSDT",
    ETH: "ETHUSDT",
  });

/**
 * User-facing payment amount precision.
 *
 * 8 decimal places:
 * - BTC-এর জন্য যথেষ্ট practical precision
 * - LTC / SOL / ETH-এর জন্যও recharge flow-এ যথেষ্ট
 * - excessively long decimal amount user-কে দেখানো লাগে না
 */
const ASSET_PRECISION =
  Object.freeze({
    BTC: 8,
    LTC: 8,
    SOL: 8,
    ETH: 8,
  });

/**
 * Asset normalize + whitelist validation.
 */
function normalizeAsset(value) {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new Error(
      "crypto_quote_asset_required"
    );
  }

  const asset =
    value
      .trim()
      .toUpperCase();

  if (
    !SUPPORTED_QUOTE_ASSETS
      .includes(asset)
  ) {
    throw new Error(
      `crypto_quote_asset_not_supported_${asset}`
    );
  }

  return asset;
}

/**
 * USD amount validation.
 */
function normalizeUsdAmount(value) {
  const amount =
    Number(value);

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error(
      "invalid_crypto_quote_usd_amount"
    );
  }

  return Number(
    amount.toFixed(2)
  );
}

/**
 * Binance price validation.
 */
function normalizeMarketPrice(value) {
  const price =
    Number(value);

  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw new Error(
      "invalid_binance_crypto_market_price"
    );
  }

  return price;
}

/**
 * Crypto amount round.
 *
 * toFixed() string return করে, যাতে floating-point
 * scientific notation API/database-এ না যায়।
 */
function formatCryptoAmount({
  asset,
  amount,
}) {
  const precision =
    ASSET_PRECISION[asset];

  const numericAmount =
    Number(amount);

  if (
    !Number.isFinite(
      numericAmount
    ) ||
    numericAmount <= 0
  ) {
    throw new Error(
      "invalid_calculated_crypto_amount"
    );
  }

  const formatted =
    numericAmount.toFixed(
      precision
    );

  /*
   * Extremely small amount precision-এর পরে zero হয়ে গেলে
   * unsafe order create না করে reject করব।
   */
  if (
    Number(formatted) <= 0
  ) {
    throw new Error(
      "crypto_quote_amount_below_precision"
    );
  }

  return formatted;
}

/**
 * Binance থেকে একটি asset-এর current market price নেয়।
 *
 * Public endpoint:
 * GET /api/v3/ticker/price?symbol=BTCUSDT
 */
async function getAssetPrice(
  asset
) {
  const normalizedAsset =
    normalizeAsset(asset);

  const symbol =
    ASSET_SYMBOL_MAP[
      normalizedAsset
    ];

  const response =
    await binanceClient
      .publicGet(
        "/api/v3/ticker/price",
        {
          symbol,
        }
      );

  const responseSymbol =
    String(
      response?.data?.symbol ||
        ""
    )
      .trim()
      .toUpperCase();

  if (
    responseSymbol !== symbol
  ) {
    throw new Error(
      "invalid_binance_quote_symbol"
    );
  }

  const price =
    normalizeMarketPrice(
      response?.data?.price
    );

  return {
    asset:
      normalizedAsset,

    symbol,

    quoteAsset:
      "USDT",

    price,

    priceText:
      String(
        response.data.price
      ),

    fetchedAt:
      new Date(),
  };
}

/**
 * USD recharge amount → crypto amount quote.
 *
 * Example:
 *
 * amountUsd = 5
 * BTCUSDT = 120000
 *
 * 5 / 120000
 * = 0.000041666...
 *
 * expectedCryptoAmount
 * = 0.00004167
 */
async function createUsdQuote({
  asset,
  amountUsd,
}) {
  const normalizedAsset =
    normalizeAsset(asset);

  const normalizedAmountUsd =
    normalizeUsdAmount(
      amountUsd
    );

  const market =
    await getAssetPrice(
      normalizedAsset
    );

  const rawCryptoAmount =
    normalizedAmountUsd /
    market.price;

  const expectedCryptoAmount =
    formatCryptoAmount({
      asset:
        normalizedAsset,

      amount:
        rawCryptoAmount,
    });

  return {
    asset:
      normalizedAsset,

    amountUsd:
      normalizedAmountUsd,

    symbol:
      market.symbol,

    quoteAsset:
      market.quoteAsset,

    marketPrice:
      market.price,

    marketPriceText:
      market.priceText,

    expectedCryptoAmount,

    precision:
      ASSET_PRECISION[
        normalizedAsset
      ],

    source:
      "binance_spot_ticker",

    quotedAt:
      market.fetchedAt,
  };
}

/**
 * Convenience helper.
 *
 * createOnchainOrder() শুধু expected amount চাইলে
 * এই function ব্যবহার করতে পারবে।
 */
async function getExpectedCryptoAmount({
  asset,
  amountUsd,
}) {
  const quote =
    await createUsdQuote({
      asset,
      amountUsd,
    });

  return quote
    .expectedCryptoAmount;
}

/**
 * Useful for startup/unit testing.
 */
function isSupportedAsset(asset) {
  if (
    typeof asset !== "string"
  ) {
    return false;
  }

  return SUPPORTED_QUOTE_ASSETS
    .includes(
      asset
        .trim()
        .toUpperCase()
    );
}

module.exports = {
  SUPPORTED_QUOTE_ASSETS,
  ASSET_SYMBOL_MAP,
  ASSET_PRECISION,

  isSupportedAsset,

  getAssetPrice,
  createUsdQuote,
  getExpectedCryptoAmount,
};