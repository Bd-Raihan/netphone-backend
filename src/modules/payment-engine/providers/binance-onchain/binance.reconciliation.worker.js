"use strict";

const os = require("os");
const crypto = require("crypto");

const reconciliationRepository = require(
  "../../payment.reconciliation.repository"
);

const paymentRepository = require(
  "../../payment.repository"
);

const binanceDepositService = require(
  "./binance.deposit.service"
);

const {
  PAYMENT_PROVIDERS,
} = require("../../payment.constants");

const PROVIDER =
  PAYMENT_PROVIDERS.BINANCE_ONCHAIN;

/*
 * Default runtime settings.
 *
 * পরে VPS .env থেকে প্রয়োজন অনুযায়ী পরিবর্তন করা যাবে।
 */
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_STALE_LOCK_SECONDS = 300;

const DEFAULT_RETRY_SECONDS = 30;
const MAX_RETRY_SECONDS = 15 * 60;

let running = false;
let processing = false;
let stopRequested = false;
let timer = null;

let currentWorkerId = null;

const runtimeStats = {
  startedAt: null,
  stoppedAt: null,

  loops: 0,
  claimed: 0,

  completed: 0,
  retried: 0,
  manualReview: 0,
  failed: 0,

  alreadyCredited: 0,
  awaitingTxHash: 0,
  depositNotFound: 0,
  confirming: 0,

  staleJobsRecovered: 0,

  expiredOrders: 0,

  lastLoopStartedAt: null,
  lastLoopFinishedAt: null,

  lastSuccessAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
};

function normalizeInteger(
  value,
  fallback,
  minimum,
  maximum
) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(
    Math.max(parsed, minimum),
    maximum
  );
}

function getPollIntervalMs() {
  return normalizeInteger(
    process.env
      .BINANCE_RECONCILIATION_POLL_MS,
    DEFAULT_POLL_INTERVAL_MS,
    5_000,
    300_000
  );
}

function getBatchSize() {
  return normalizeInteger(
    process.env
      .BINANCE_RECONCILIATION_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
    1,
    100
  );
}

function getStaleLockSeconds() {
  return normalizeInteger(
    process.env
      .BINANCE_RECONCILIATION_STALE_SECONDS,
    DEFAULT_STALE_LOCK_SECONDS,
    30,
    86_400
  );
}

function isWorkerEnabled() {
  const value = String(
    process.env
      .BINANCE_RECONCILIATION_ENABLED ||
      "false"
  )
    .trim()
    .toLowerCase();

  return [
    "1",
    "true",
    "yes",
    "on",
  ].includes(value);
}

function createWorkerId() {
  const hostname = String(
    os.hostname() || "unknown-host"
  )
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .slice(0, 50);

  const randomPart = crypto
    .randomBytes(4)
    .toString("hex");

  const processId =
    Number(process.pid) || 0;

  return [
    "binance-onchain",
    hostname,
    processId,
    randomPart,
  ]
    .join(":")
    .slice(0, 120);
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function sanitizeError(error) {
  return {
    name:
      error?.name ||
      "Error",

    message:
      String(
        error?.message ||
        "unknown_worker_error"
      ).slice(0, 2000),

    code:
      error?.code ||
      null,

    binanceCode:
      error?.binanceCode ??
      null,

    statusCode:
      error?.statusCode ??
      null,
  };
}

/*
 * Exponential retry delay.
 *
 * attempt 1  → approximately 30 seconds
 * attempt 2  → approximately 60 seconds
 * attempt 3  → approximately 120 seconds
 *
 * Maximum 15 minutes.
 */
function calculateRetrySeconds(
  attemptCount
) {
  const attempt = normalizeInteger(
    attemptCount,
    1,
    1,
    20
  );

  const baseSeconds =
    DEFAULT_RETRY_SECONDS *
    2 ** Math.min(
      attempt - 1,
      5
    );

  const jitterSeconds =
    Math.floor(
      Math.random() * 10
    );

  return Math.min(
    baseSeconds + jitterSeconds,
    MAX_RETRY_SECONDS
  );
}

/*
 * যেসব error সাময়িক এবং পুনরায় চেষ্টা করা নিরাপদ।
 */
function isRetryableError(error) {
  const statusCode =
    Number(
      error?.statusCode || 0
    );

  const binanceCode =
    Number(
      error?.binanceCode
    );

  if (
    statusCode === 418 ||
    statusCode === 429 ||
    statusCode >= 500
  ) {
    return true;
  }

  if (
    [
      -1000,
      -1001,
      -1003,
      -1006,
      -1007,
      -1021,
    ].includes(binanceCode)
  ) {
    return true;
  }

  const message = String(
    error?.message || ""
  ).toLowerCase();

  return [
    "timeout",
    "econnreset",
    "socket hang up",
    "temporarily unavailable",
    "network",
    "connection",
    "rate limit",
    "too many requests",
  ].some((text) =>
    message.includes(text)
  );
}

/*
 * যেসব error configuration/security সমস্যা।
 *
 * এগুলো বারবার retry করলে লাভ নেই।
 */
function isPermanentConfigurationError(
  error
) {
  const message = String(
    error?.message || ""
  ).toLowerCase();

  const binanceCode =
    Number(
      error?.binanceCode
    );

  if (
    [
      -2014,
      -2015,
    ].includes(binanceCode)
  ) {
    return true;
  }

  return [
    "binance_api_key_missing",
    "binance_api_secret_missing",
    "invalid_binance_recv_window",
    "binance_onchain_config_missing",
    "payment_provider_mismatch",
  ].some((text) =>
    message.includes(text)
  );
}

function logInfo(
  message,
  details = null
) {
  if (details) {
    console.log(
      `[BINANCE RECONCILIATION] ${message}`,
      details
    );

    return;
  }

  console.log(
    `[BINANCE RECONCILIATION] ${message}`
  );
}

function logError(
  message,
  error,
  details = null
) {
  const safeError =
    sanitizeError(error);

  console.error(
    `[BINANCE RECONCILIATION ERROR] ${message}`,
    {
      ...safeError,
      ...(details || {}),
    }
  );
}

/*
 * Deposit verification result অনুযায়ী queue job update।
 */
async function handleVerificationResult({
  job,
  result,
  workerId,
}) {
  const resultType =
    result?.result;

  switch (resultType) {
    case "credited":
    case "already_credited": {
      const completedJob =
        await reconciliationRepository
          .markJobCompleted({
            jobId:
              job.id,

            workerId,

            resultPayload: {
              result:
                resultType,

              paymentOrderId:
                job.payment_order_id,

              provider:
                PROVIDER,

              credited:
                true,

              duplicated:
                Boolean(
                  result
                    ?.creditResult
                    ?.duplicated
                ),
            },
          });

      if (!completedJob) {
        throw new Error(
          "unable_to_complete_reconciliation_job"
        );
      }

      runtimeStats.completed += 1;
      runtimeStats.lastSuccessAt =
        new Date().toISOString();

      if (
        resultType ===
        "already_credited"
      ) {
        runtimeStats
          .alreadyCredited += 1;
      }

      return {
        action:
          "completed",

        result:
          resultType,

        job:
          completedJob,
      };
    }

    case "awaiting_tx_hash": {
      const retrySeconds =
        Number(
          result
            ?.retryAfterSeconds
        ) ||
        DEFAULT_RETRY_SECONDS;

      const retryJob =
        await reconciliationRepository
          .markJobForRetry({
            jobId:
              job.id,

            workerId,

            delaySeconds:
              retrySeconds,

            errorCode:
              "awaiting_tx_hash",

            errorMessage:
              "Waiting for user transaction hash submission",

            resultPayload: {
              result:
                resultType,

              paymentOrderId:
                job.payment_order_id,
            },
          });

      if (!retryJob) {
        throw new Error(
          "unable_to_retry_reconciliation_job"
        );
      }

      runtimeStats.retried += 1;
      runtimeStats
        .awaitingTxHash += 1;

      return {
        action:
          "retry",

        result:
          resultType,

        job:
          retryJob,
      };
    }

    case "deposit_not_found": {
      const retrySeconds =
        Number(
          result
            ?.retryAfterSeconds
        ) ||
        calculateRetrySeconds(
          job.attempt_count
        );

      const retryJob =
        await reconciliationRepository
          .markJobForRetry({
            jobId:
              job.id,

            workerId,

            delaySeconds:
              retrySeconds,

            errorCode:
              "deposit_not_found",

            errorMessage:
              "Matching Binance deposit was not found yet",

            resultPayload: {
              result:
                resultType,

              paymentOrderId:
                job.payment_order_id,

              txHashPresent:
                Boolean(
                  result
                    ?.order
                    ?.tx_hash
                ),
            },
          });

      if (!retryJob) {
        throw new Error(
          "unable_to_retry_reconciliation_job"
        );
      }

      runtimeStats.retried += 1;
      runtimeStats
        .depositNotFound += 1;

      return {
        action:
          retryJob.job_status ===
          "failed"
            ? "failed"
            : "retry",

        result:
          resultType,

        job:
          retryJob,
      };
    }

    case "confirming": {
      const retrySeconds =
        Number(
          result
            ?.retryAfterSeconds
        ) ||
        DEFAULT_RETRY_SECONDS;

      const retryJob =
        await reconciliationRepository
          .markJobForRetry({
            jobId:
              job.id,

            workerId,

            delaySeconds:
              retrySeconds,

            errorCode:
              "confirmations_pending",

            errorMessage:
              "Deposit found; waiting for required confirmations",

            resultPayload: {
              result:
                resultType,

              paymentOrderId:
                job.payment_order_id,

              confirmations:
                result
                  ?.validation
                  ?.confirmations ??
                null,

              requiredConfirmations:
                result
                  ?.validation
                  ?.requiredConfirmations ??
                null,

              txHash:
                result
                  ?.deposit
                  ?.txHash ||
                null,
            },
          });

      if (!retryJob) {
        throw new Error(
          "unable_to_retry_reconciliation_job"
        );
      }

      runtimeStats.retried += 1;
      runtimeStats.confirming += 1;

      return {
        action:
          "retry",

        result:
          resultType,

        job:
          retryJob,
      };
    }

    case "manual_review": {
      const reviewReason =
        result
          ?.validation
          ?.failures
          ?.join(",") ||
        result
          ?.order
          ?.review_reason ||
        "Automatic Binance verification requires manual review";

      const reviewJob =
        await reconciliationRepository
          .markJobForManualReview({
            jobId:
              job.id,

            workerId,

            reason:
              reviewReason,

            resultPayload: {
              result:
                resultType,

              paymentOrderId:
                job.payment_order_id,

              failures:
                result
                  ?.validation
                  ?.failures ||
                [],

              txHash:
                result
                  ?.deposit
                  ?.txHash ||
                null,
            },
          });

      if (!reviewJob) {
        throw new Error(
          "unable_to_mark_reconciliation_manual_review"
        );
      }

      runtimeStats.manualReview += 1;

      return {
        action:
          "manual_review",

        result:
          resultType,

        job:
          reviewJob,
      };
    }

    case "finalized_without_credit": {
      const failedJob =
        await reconciliationRepository
          .markJobFailed({
            jobId:
              job.id,

            workerId,

            errorCode:
              "payment_order_finalized_without_credit",

            errorMessage:
              "Payment order was already finalized without wallet credit",

            resultPayload: {
              result:
                resultType,

              paymentOrderId:
                job.payment_order_id,

              paymentStatus:
                result
                  ?.order
                  ?.status ||
                null,
            },
          });

      if (!failedJob) {
        throw new Error(
          "unable_to_fail_reconciliation_job"
        );
      }

      runtimeStats.failed += 1;

      return {
        action:
          "failed",

        result:
          resultType,

        job:
          failedJob,
      };
    }

    default: {
      throw new Error(
        `unknown_deposit_verification_result:${String(
          resultType || "null"
        )}`
      );
    }
  }
}

/*
 * একটি claimed queue job process করে।
 */
async function processJob({
  job,
  workerId,
}) {
  if (!job) {
    throw new Error(
      "reconciliation_job_required"
    );
  }

  try {
    const jobWithOrder =
      await reconciliationRepository
        .getJobWithOrder({
          jobId:
            job.id,
        });

    if (!jobWithOrder) {
      const failedJob =
        await reconciliationRepository
          .markJobFailed({
            jobId:
              job.id,

            workerId,

            errorCode:
              "linked_payment_order_missing",

            errorMessage:
              "Linked payment order could not be loaded",

            resultPayload: {
              paymentOrderId:
                job.payment_order_id,
            },
          });

      runtimeStats.failed += 1;

      return {
        action:
          "failed",

        job:
          failedJob,
      };
    }

    if (
      jobWithOrder.provider !==
      PROVIDER
    ) {
      const failedJob =
        await reconciliationRepository
          .markJobFailed({
            jobId:
              job.id,

            workerId,

            errorCode:
              "reconciliation_provider_mismatch",

            errorMessage:
              "Queue job provider is not Binance On-chain",

            resultPayload: {
              actualProvider:
                jobWithOrder.provider,

              expectedProvider:
                PROVIDER,
            },
          });

      runtimeStats.failed += 1;

      return {
        action:
          "failed",

        job:
          failedJob,
      };
    }

    const verificationResult =
      await binanceDepositService
        .verifyOrderDeposit({
          orderId:
            job.payment_order_id,
        });

    return handleVerificationResult({
      job,
      result:
        verificationResult,
      workerId,
    });
  } catch (error) {
    const safeError =
      sanitizeError(error);

    runtimeStats.lastErrorAt =
      new Date().toISOString();

    runtimeStats.lastErrorMessage =
      safeError.message;

    /*
     * Binance/API temporary error:
     * retry with exponential backoff.
     */
    if (isRetryableError(error)) {
      const retrySeconds =
        calculateRetrySeconds(
          job.attempt_count
        );

      const retryJob =
        await reconciliationRepository
          .markJobForRetry({
            jobId:
              job.id,

            workerId,

            delaySeconds:
              retrySeconds,

            errorCode:
              safeError.binanceCode
                ? `binance_${safeError.binanceCode}`
                : safeError.code ||
                  "temporary_reconciliation_error",

            errorMessage:
              safeError.message,

            resultPayload: {
              retryable:
                true,

              statusCode:
                safeError.statusCode,

              binanceCode:
                safeError.binanceCode,
            },
          });

      runtimeStats.retried += 1;

      logError(
        "Temporary error; job scheduled for retry",
        error,
        {
          jobId:
            job.id,

          paymentOrderId:
            job.payment_order_id,

          retrySeconds,
        }
      );

      return {
        action:
          retryJob?.job_status ===
          "failed"
            ? "failed"
            : "retry",

        job:
          retryJob,

        error:
          safeError,
      };
    }

    /*
     * API key/IP/permission/configuration সমস্যা:
     * এটি user payment mismatch নয়।
     * Job manual review-এ না পাঠিয়ে failed রাখা হবে,
     * যাতে configuration ঠিক না হওয়া পর্যন্ত ভুল credit না হয়।
     */
    if (
      isPermanentConfigurationError(
        error
      )
    ) {
      const failedJob =
        await reconciliationRepository
          .markJobFailed({
            jobId:
              job.id,

            workerId,

            errorCode:
              safeError.binanceCode
                ? `binance_${safeError.binanceCode}`
                : safeError.code ||
                  "binance_configuration_error",

            errorMessage:
              safeError.message,

            resultPayload: {
              configurationError:
                true,

              statusCode:
                safeError.statusCode,

              binanceCode:
                safeError.binanceCode,
            },
          });

      runtimeStats.failed += 1;

      logError(
        "Permanent Binance configuration error",
        error,
        {
          jobId:
            job.id,

          paymentOrderId:
            job.payment_order_id,
        }
      );

      return {
        action:
          "failed",

        job:
          failedJob,

        error:
          safeError,
      };
    }

    /*
     * Unknown permanent processing error.
     */
    const failedJob =
      await reconciliationRepository
        .markJobFailed({
          jobId:
            job.id,

          workerId,

          errorCode:
            safeError.code ||
            "reconciliation_processing_failed",

          errorMessage:
            safeError.message,

          resultPayload: {
            statusCode:
              safeError.statusCode,

            binanceCode:
              safeError.binanceCode,
          },
        });

    runtimeStats.failed += 1;

    logError(
      "Job processing failed",
      error,
      {
        jobId:
          job.id,

        paymentOrderId:
          job.payment_order_id,
      }
    );

    return {
      action:
        "failed",

      job:
        failedJob,

      error:
        safeError,
    };
  }
}

/*
 * একটি worker cycle।
 *
 * প্রথমে stale processing locks recover করে।
 * এরপর ready jobs batch claim ও process করে।
 */
async function runOnce({
  workerId =
    currentWorkerId ||
    createWorkerId(),

  batchSize =
    getBatchSize(),
} = {}) {
  const normalizedWorkerId =
    String(workerId)
      .trim()
      .slice(0, 120);

  if (!normalizedWorkerId) {
    throw new Error(
      "invalid_worker_id"
    );
  }

  if (processing) {
    return {
      ok: true,
      skipped: true,
      reason:
        "worker_cycle_already_running",
    };
  }

  processing = true;

  runtimeStats.loops += 1;

  runtimeStats.lastLoopStartedAt =
    new Date().toISOString();

  try {
  const expiredOrders =
    await paymentRepository
      .expireUnpaidPaymentOrders({
        provider:
          PROVIDER,

        limit:
          Math.max(
            batchSize * 2,
            100
          ),
      });

  runtimeStats.expiredOrders +=
    expiredOrders.length;

  if (expiredOrders.length > 0) {
    logInfo(
      "Expired unpaid payment orders",
      {
        count:
          expiredOrders.length,

        orderIds:
          expiredOrders.map(
            (order) => order.id
          ),
      }
    );
  }

  const recoveredJobs =
    await reconciliationRepository
      .recoverStaleJobs({
        staleAfterSeconds:
          getStaleLockSeconds(),

        limit:
          Math.max(
            batchSize * 2,
            100
          ),
      });

  runtimeStats
    .staleJobsRecovered +=
    recoveredJobs.length;

  if (recoveredJobs.length > 0) {
    logInfo(
      "Recovered stale reconciliation jobs",
      {
        count:
          recoveredJobs.length,
      }
    );
  }

  const jobs =
    await reconciliationRepository
      .claimReadyJobs({
        workerId:
          normalizedWorkerId,

        provider:
          PROVIDER,

        limit:
          batchSize,
      });

  runtimeStats.claimed +=
    jobs.length;

  if (!jobs.length) {
    return {
      ok: true,

      workerId:
        normalizedWorkerId,

      claimed:
        0,

      expired:
        expiredOrders.length,

      results: [],
    };
  }

  /*
   * Sequential processing intentionally used.
   *
   * Binance signed Deposit History endpoint rate-limit রক্ষা করে।
   * High volume scaling-এর জন্য একাধিক PM2 worker/process
   * চালানো যাবে; SKIP LOCKED duplicate claim আটকাবে।
   */
  const results = [];

  for (const job of jobs) {
    if (stopRequested) {
      /*
       * Already claimed job processing অবস্থায় ফেলে রাখা হবে না।
       * Short retry দিয়ে queue-তে ফেরত পাঠানো হবে।
       */
      const retryJob =
        await reconciliationRepository
          .markJobForRetry({
            jobId:
              job.id,

            workerId:
              normalizedWorkerId,

            delaySeconds:
              5,

            errorCode:
              "worker_stopping",

            errorMessage:
              "Worker shutdown requested before job processing",

            resultPayload: {
              shutdown:
                true,
            },
          });

      results.push({
        jobId:
          job.id,

        action:
          "retry",

        job:
          retryJob,
      });

      continue;
    }

    const result =
      await processJob({
        job,

        workerId:
          normalizedWorkerId,
      });

    results.push({
      jobId:
        job.id,

      paymentOrderId:
        job.payment_order_id,

      ...result,
    });
  }

  return {
    ok: true,

    workerId:
      normalizedWorkerId,

    claimed:
      jobs.length,

    expired:
      expiredOrders.length,

    results,
  };
} catch (error) {
    runtimeStats.lastErrorAt =
      new Date().toISOString();

    runtimeStats.lastErrorMessage =
      String(
        error?.message ||
        "worker_cycle_failed"
      );

    logError(
      "Worker cycle failed",
      error
    );

    throw error;
  } finally {
    processing = false;

    runtimeStats.lastLoopFinishedAt =
      new Date().toISOString();
  }
}

function scheduleNextCycle() {
  if (
    !running ||
    stopRequested
  ) {
    return;
  }

  const intervalMs =
    getPollIntervalMs();

  timer = setTimeout(
    async () => {
      timer = null;

      try {
        await runOnce({
          workerId:
            currentWorkerId,
        });
      } catch (_) {
        /*
         * Error ইতোমধ্যে sanitized form-এ log হয়েছে।
         * Worker বন্ধ না করে next cycle চালু রাখা হবে।
         */
      } finally {
        scheduleNextCycle();
      }
    },
    intervalMs
  );

  if (
    typeof timer.unref ===
    "function"
  ) {
    timer.unref();
  }
}

/*
 * Continuous background worker start।
 */
async function start({
  force = false,
  runImmediately = true,
} = {}) {
  if (running) {
    return {
      ok: true,
      alreadyRunning: true,
      workerId:
        currentWorkerId,
    };
  }

  if (
    !force &&
    !isWorkerEnabled()
  ) {
    return {
      ok: true,
      started: false,
      reason:
        "binance_reconciliation_disabled",
    };
  }

  currentWorkerId =
    createWorkerId();

  running = true;
  stopRequested = false;

  runtimeStats.startedAt =
    new Date().toISOString();

  runtimeStats.stoppedAt =
    null;

  logInfo(
    "Worker started",
    {
      workerId:
        currentWorkerId,

      pollIntervalMs:
        getPollIntervalMs(),

      batchSize:
        getBatchSize(),
    }
  );

  if (runImmediately) {
    try {
      await runOnce({
        workerId:
          currentWorkerId,
      });
    } catch (_) {
      /*
       * First cycle failure worker-কে permanently
       * বন্ধ করবে না।
       */
    }
  }

  scheduleNextCycle();

  return {
    ok: true,
    started: true,

    workerId:
      currentWorkerId,
  };
}

/*
 * Graceful worker stop।
 */
async function stop({
  waitTimeoutMs = 30_000,
} = {}) {
  if (!running) {
    return {
      ok: true,
      alreadyStopped: true,
    };
  }

  stopRequested = true;
  running = false;

  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  const startedWaitingAt =
    Date.now();

  while (
    processing &&
    Date.now() -
      startedWaitingAt <
      waitTimeoutMs
  ) {
    await sleep(100);
  }

  runtimeStats.stoppedAt =
    new Date().toISOString();

  const stoppedWorkerId =
    currentWorkerId;

  currentWorkerId = null;

  logInfo(
    "Worker stopped",
    {
      workerId:
        stoppedWorkerId,

      processingFinished:
        !processing,
    }
  );

  return {
    ok: true,
    stopped: true,

    workerId:
      stoppedWorkerId,

    processingFinished:
      !processing,
  };
}

function getStatus() {
  return {
    provider:
      PROVIDER,

    enabled:
      isWorkerEnabled(),

    running,
    processing,
    stopRequested,

    workerId:
      currentWorkerId,

    configuration: {
      pollIntervalMs:
        getPollIntervalMs(),

      batchSize:
        getBatchSize(),

      staleLockSeconds:
        getStaleLockSeconds(),
    },

    stats: {
      ...runtimeStats,
    },
  };
}

module.exports = {
  PROVIDER,

  start,
  stop,

  runOnce,
  processJob,

  getStatus,

  isWorkerEnabled,
  calculateRetrySeconds,
  isRetryableError,
};