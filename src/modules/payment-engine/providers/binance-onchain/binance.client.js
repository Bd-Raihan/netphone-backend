"use strict";

const crypto = require("crypto");
const https = require("https");
const { URL } = require("url");

const DEFAULT_BASE_URL =
  "https://api.binance.com";

const DEFAULT_RECV_WINDOW = 5000;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RETRY_ATTEMPTS = 3;

let cachedTimeOffsetMs = 0;
let lastTimeSyncAt = 0;

function getConfig() {
  const apiKey =
    String(
      process.env.BINANCE_API_KEY || ""
    ).trim();

  const apiSecret =
    String(
      process.env.BINANCE_API_SECRET || ""
    ).trim();

  const baseUrl =
    String(
      process.env.BINANCE_API_BASE ||
        DEFAULT_BASE_URL
    )
      .trim()
      .replace(/\/+$/, "");

  const recvWindow =
    Number(
      process.env.BINANCE_RECV_WINDOW ||
        DEFAULT_RECV_WINDOW
    );

  if (!apiKey) {
    throw new Error(
      "binance_api_key_missing"
    );
  }

  if (!apiSecret) {
    throw new Error(
      "binance_api_secret_missing"
    );
  }

  if (
    !Number.isFinite(recvWindow) ||
    recvWindow <= 0 ||
    recvWindow > 60000
  ) {
    throw new Error(
      "invalid_binance_recv_window"
    );
  }

  return {
    apiKey,
    apiSecret,
    baseUrl,
    recvWindow,
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function normalizeQueryValue(value) {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return String(value);
}

function buildQueryString(params = {}) {
  const entries = Object.entries(params)
    .filter(
      ([, value]) =>
        value !== undefined &&
        value !== null &&
        value !== ""
    )
    .sort(([keyA], [keyB]) =>
      keyA.localeCompare(keyB)
    );

  const searchParams =
    new URLSearchParams();

  for (const [key, value] of entries) {
    searchParams.append(
      key,
      normalizeQueryValue(value)
    );
  }

  return searchParams.toString();
}

function createHmacSignature(
  queryString,
  apiSecret
) {
  return crypto
    .createHmac(
      "sha256",
      apiSecret
    )
    .update(queryString)
    .digest("hex");
}

function sanitizeUrlForError(url) {
  try {
    const parsed = new URL(url);

    if (
      parsed.searchParams.has(
        "signature"
      )
    ) {
      parsed.searchParams.set(
        "signature",
        "[REDACTED]"
      );
    }

    return parsed.toString();
  } catch (_) {
    return "[INVALID_URL]";
  }
}

function requestJson({
  method = "GET",
  url,
  headers = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  return new Promise(
    (resolve, reject) => {
      const request = https.request(
        url,
        {
          method,
          headers: {
            Accept:
              "application/json",
            "User-Agent":
              "NetPhone-Payment-Engine/1.0",
            ...headers,
          },
          timeout:
            timeoutMs,
        },
        (response) => {
          let rawBody = "";

          response.setEncoding(
            "utf8"
          );

          response.on(
            "data",
            (chunk) => {
              rawBody += chunk;

              if (
                rawBody.length >
                5 * 1024 * 1024
              ) {
                response.destroy();

                reject(
                  new Error(
                    "binance_response_too_large"
                  )
                );
              }
            }
          );

          response.on(
            "end",
            () => {
              let parsedBody = null;

              if (rawBody) {
                try {
                  parsedBody =
                    JSON.parse(
                      rawBody
                    );
                } catch (_) {
                  parsedBody = {
                    raw:
                      rawBody.slice(
                        0,
                        2000
                      ),
                  };
                }
              }

              const statusCode =
                Number(
                  response.statusCode ||
                    0
                );

              const responseHeaders =
                response.headers || {};

              if (
                statusCode >= 200 &&
                statusCode < 300
              ) {
                return resolve({
                  statusCode,
                  headers:
                    responseHeaders,
                  data:
                    parsedBody,
                });
              }

              const error =
                new Error(
                  parsedBody?.msg ||
                    `binance_http_${statusCode}`
                );

              error.name =
                "BinanceApiError";

              error.statusCode =
                statusCode;

              error.binanceCode =
                parsedBody?.code ??
                null;

              error.binanceMessage =
                parsedBody?.msg ??
                null;

              error.response =
                parsedBody;

              error.retryAfter =
                responseHeaders[
                  "retry-after"
                ] || null;

              error.requestUrl =
                sanitizeUrlForError(
                  url
                );

              return reject(error);
            }
          );
        }
      );

      request.on(
        "timeout",
        () => {
          request.destroy(
            new Error(
              "binance_request_timeout"
            )
          );
        }
      );

      request.on(
        "error",
        (error) => {
          reject(error);
        }
      );

      request.end();
    }
  );
}

function isRetryableError(error) {
  const statusCode =
    Number(
      error?.statusCode || 0
    );

  if (
    statusCode === 418 ||
    statusCode === 429
  ) {
    return true;
  }

  if (statusCode >= 500) {
    return true;
  }

  const message =
    String(
      error?.message || ""
    ).toLowerCase();

  return (
    message.includes(
      "timeout"
    ) ||
    message.includes(
      "econnreset"
    ) ||
    message.includes(
      "socket hang up"
    ) ||
    message.includes(
      "temporarily unavailable"
    )
  );
}

function calculateRetryDelay({
  attempt,
  error,
}) {
  const retryAfterSeconds =
    Number(
      error?.retryAfter || 0
    );

  if (
    Number.isFinite(
      retryAfterSeconds
    ) &&
    retryAfterSeconds > 0
  ) {
    return Math.min(
      retryAfterSeconds *
        1000,
      60000
    );
  }

  const baseDelay =
    Math.min(
      1000 *
        2 ** (attempt - 1),
      15000
    );

  const jitter =
    Math.floor(
      Math.random() * 500
    );

  return baseDelay + jitter;
}

async function executeWithRetry(
  operation,
  {
    maxAttempts =
      MAX_RETRY_ATTEMPTS,
  } = {}
) {
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt += 1
  ) {
    try {
      return await operation(
        attempt
      );
    } catch (error) {
      lastError = error;

      if (
        attempt >=
          maxAttempts ||
        !isRetryableError(
          error
        )
      ) {
        throw error;
      }

      const delay =
        calculateRetryDelay({
          attempt,
          error,
        });

      await sleep(delay);
    }
  }

  throw lastError;
}

async function publicGet(
  path,
  params = {},
  options = {}
) {
  const {
    baseUrl,
  } = getConfig();

  const queryString =
    buildQueryString(params);

  const url =
    queryString
      ? `${baseUrl}${path}?${queryString}`
      : `${baseUrl}${path}`;

  return executeWithRetry(
    () =>
      requestJson({
        method: "GET",
        url,
        timeoutMs:
          options.timeoutMs ||
          DEFAULT_TIMEOUT_MS,
      }),
    options
  );
}

async function getServerTime() {
  const response =
    await publicGet(
      "/api/v3/time"
    );

  const serverTime =
    Number(
      response.data?.serverTime
    );

  if (
    !Number.isFinite(
      serverTime
    ) ||
    serverTime <= 0
  ) {
    throw new Error(
      "invalid_binance_server_time"
    );
  }

  return serverTime;
}

async function synchronizeTime({
  force = false,
} = {}) {
  const now = Date.now();

  if (
    !force &&
    lastTimeSyncAt > 0 &&
    now - lastTimeSyncAt <
      5 * 60 * 1000
  ) {
    return {
      offsetMs:
        cachedTimeOffsetMs,
      syncedAt:
        lastTimeSyncAt,
    };
  }

  const requestStartedAt =
    Date.now();

  const serverTime =
    await getServerTime();

  const requestFinishedAt =
    Date.now();

  const estimatedLocalTime =
    Math.floor(
      (
        requestStartedAt +
        requestFinishedAt
      ) / 2
    );

  cachedTimeOffsetMs =
    serverTime -
    estimatedLocalTime;

  lastTimeSyncAt =
    requestFinishedAt;

  return {
    offsetMs:
      cachedTimeOffsetMs,
    syncedAt:
      lastTimeSyncAt,
    serverTime,
  };
}

async function getSignedTimestamp() {
  if (
    !lastTimeSyncAt ||
    Date.now() -
      lastTimeSyncAt >
      5 * 60 * 1000
  ) {
    await synchronizeTime();
  }

  return (
    Date.now() +
    cachedTimeOffsetMs
  );
}

async function signedGet(
  path,
  params = {},
  options = {}
) {
  const config =
    getConfig();

  const makeRequest =
    async ({
      forceTimeSync = false,
    } = {}) => {
      if (forceTimeSync) {
        await synchronizeTime({
          force: true,
        });
      }

      const timestamp =
        await getSignedTimestamp();

      const signedParams = {
        ...params,
        recvWindow:
          options.recvWindow ||
          config.recvWindow,
        timestamp,
      };

      const queryString =
        buildQueryString(
          signedParams
        );

      const signature =
        createHmacSignature(
          queryString,
          config.apiSecret
        );

      const url =
        `${config.baseUrl}${path}` +
        `?${queryString}` +
        `&signature=${signature}`;

      return requestJson({
        method: "GET",
        url,
        timeoutMs:
          options.timeoutMs ||
          DEFAULT_TIMEOUT_MS,
        headers: {
          "X-MBX-APIKEY":
            config.apiKey,
        },
      });
    };

  try {
    return await executeWithRetry(
      () => makeRequest(),
      options
    );
  } catch (error) {
    /*
     * Binance timestamp error:
     * -1021 Timestamp outside recvWindow.
     */
    if (
      Number(
        error?.binanceCode
      ) === -1021
    ) {
      return executeWithRetry(
        () =>
          makeRequest({
            forceTimeSync:
              true,
          }),
        {
          ...options,
          maxAttempts: 2,
        }
      );
    }

    throw error;
  }
}

function normalizeCoin(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  return String(value)
    .trim()
    .toUpperCase();
}

function normalizeTimestamp(
  value,
  fieldName
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const timestamp =
    value instanceof Date
      ? value.getTime()
      : Number(value);

  if (
    !Number.isFinite(
      timestamp
    ) ||
    timestamp <= 0
  ) {
    throw new Error(
      `invalid_${fieldName}`
    );
  }

  return Math.floor(
    timestamp
  );
}

/**
 * Official Binance Wallet deposit-history request.
 */
async function getDepositHistory({
  coin = null,
  status = null,
  startTime = null,
  endTime = null,
  offset = null,
  limit = 1000,
} = {}) {
  const normalizedLimit =
    Math.min(
      Math.max(
        Number(limit) || 1000,
        1
      ),
      1000
    );

  const params = {
    coin:
      normalizeCoin(coin),

    status:
      status === null ||
      status === undefined
        ? null
        : Number(status),

    startTime:
      normalizeTimestamp(
        startTime,
        "start_time"
      ),

    endTime:
      normalizeTimestamp(
        endTime,
        "end_time"
      ),

    offset:
      offset === null ||
      offset === undefined
        ? null
        : Math.max(
            Number(offset) || 0,
            0
          ),

    limit:
      normalizedLimit,
  };

  const response =
    await signedGet(
      "/sapi/v1/capital/deposit/hisrec",
      params
    );

  if (
    !Array.isArray(
      response.data
    )
  ) {
    throw new Error(
      "invalid_binance_deposit_history_response"
    );
  }

  return {
    deposits:
      response.data,

    rateLimit: {
      usedWeight:
        response.headers[
          "x-mbx-used-weight"
        ] || null,

      usedWeight1m:
        response.headers[
          "x-mbx-used-weight-1m"
        ] || null,
    },
  };
}

async function testConnection() {
  const serverTime =
    await getServerTime();

  await synchronizeTime({
    force: true,
  });

  const depositHistory =
    await getDepositHistory({
      limit: 1,
    });

  return {
    ok: true,
    serverTime,
    timeOffsetMs:
      cachedTimeOffsetMs,
    depositHistoryReadable:
      Array.isArray(
        depositHistory.deposits
      ),
  };
}

module.exports = {
  getConfig,

  buildQueryString,
  createHmacSignature,

  publicGet,
  signedGet,

  getServerTime,
  synchronizeTime,

  getDepositHistory,
  testConnection,
};