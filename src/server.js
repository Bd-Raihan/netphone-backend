"use strict";

/**
 * server.js
 *
 * Responsibilities:
 * - Load environment variables
 * - Start Express HTTP server
 * - Start Binance reconciliation worker when enabled
 * - Gracefully stop HTTP server and worker
 */

require("dotenv").config();

const app = require("./app");

const ratesService = require(
  "./modules/rates/rates.service"
);

const binanceReconciliationWorker = require(
  "./modules/payment-engine/providers/binance-onchain/binance.reconciliation.worker"
);

const PORT =
  Number(process.env.PORT) || 8080;

const HOST =
  process.env.HOST || "0.0.0.0";

let shuttingDown = false;

/**
 * Start HTTP server
 */
const server = app.listen(
  PORT,
  HOST,
  async () => {
    console.log(
      `🚀 AlHawari Call API running on port ${PORT}`
    );

    try {
      const workerResult =
        await binanceReconciliationWorker.start();

      if (workerResult.started) {
        console.log(
          "✅ Binance reconciliation worker started",
          {
            workerId:
              workerResult.workerId,
          }
        );
      } else {
        console.log(
          "ℹ️ Binance reconciliation worker not started",
          {
            reason:
              workerResult.reason ||
              "disabled",
          }
        );
      }
    } catch (error) {
      console.error(
        "❌ Binance reconciliation worker startup failed",
        {
          message:
            error?.message ||
            "unknown_worker_startup_error",
        }
      );
    }

        // ============================================================
    // Warm public pricing cache in background
    //
    // IMPORTANT:
    // - HTTP server is already online.
    // - Do NOT await this operation.
    // - A pricing failure must never stop the production API.
    // ============================================================
    ratesService
      .getPublicRates()
      .then((rates) => {
        console.log(
          "✅ Public rates cache warmed",
          {
            rows: Array.isArray(rates)
              ? rates.length
              : 0,
          }
        );
      })
      .catch((error) => {
        console.error(
          "⚠️ Public rates cache warm-up failed",
          {
            message:
              error?.message ||
              "unknown_rates_cache_warmup_error",
          }
        );
      });
  }
);

/**
 * Graceful shutdown
 */
async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    `\n🛑 ${signal} received. Shutting down safely...`
  );

  const forceExitTimer =
    setTimeout(() => {
      console.error(
        "❌ Graceful shutdown timeout. Forcing exit."
      );

      process.exit(1);
    }, 35_000);

  if (
    typeof forceExitTimer.unref ===
    "function"
  ) {
    forceExitTimer.unref();
  }

  try {
    await binanceReconciliationWorker.stop({
      waitTimeoutMs: 30_000,
    });
  } catch (error) {
    console.error(
      "❌ Binance reconciliation worker stop failed",
      {
        message:
          error?.message ||
          "unknown_worker_stop_error",
      }
    );
  }

  server.close((error) => {
    clearTimeout(forceExitTimer);

    if (error) {
      console.error(
        "❌ HTTP server shutdown failed",
        error
      );

      process.exit(1);
      return;
    }

    console.log(
      "✅ HTTP server stopped safely"
    );

    process.exit(0);
  });
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "❌ Uncaught exception",
      {
        message:
          error?.message ||
          "unknown_uncaught_exception",

        stack:
          error?.stack ||
          null,
      }
    );

    shutdown(
      "UNCAUGHT_EXCEPTION"
    );
  }
);

process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      "❌ Unhandled promise rejection",
      {
        message:
          reason?.message ||
          String(reason),

        stack:
          reason?.stack ||
          null,
      }
    );

    shutdown(
      "UNHANDLED_REJECTION"
    );
  }
);

module.exports = server;