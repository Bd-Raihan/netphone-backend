"use strict";

const db = require("../../config/db");

const {
  PAYMENT_PROVIDERS,
} = require("./payment.constants");

const AUTOMATIC_PROVIDERS = new Set([
  PAYMENT_PROVIDERS.BINANCE_ONCHAIN,
  PAYMENT_PROVIDERS.BINANCE_PAY,
]);

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

function normalizeWorkerId(value) {
  const normalized = String(
    value || ""
  ).trim();

  if (
    !normalized ||
    normalized.length > 120
  ) {
    throw new Error("invalid_worker_id");
  }

  return normalized;
}

function assertAutomaticProvider(provider) {
  if (!AUTOMATIC_PROVIDERS.has(provider)) {
    throw new Error(
      "unsupported_reconciliation_provider"
    );
  }
}

function toJson(value) {
  return JSON.stringify(value || {});
}

/**
 * Payment order-এর জন্য reconciliation job তৈরি করে।
 *
 * একই order-এর জন্য duplicate queue row তৈরি হবে না।
 */
async function enqueueJob({
  paymentOrderId,
  provider,

  priority = 100,
  maxAttempts = 20,

  nextAttemptAt = new Date(),

  client = null,
}) {
  const normalizedOrderId =
    normalizePositiveId(
      paymentOrderId,
      "payment_order_id"
    );

  assertAutomaticProvider(provider);

  const normalizedPriority =
    normalizeInteger(
      priority,
      100,
      1,
      32767
    );

  const normalizedMaxAttempts =
    normalizeInteger(
      maxAttempts,
      20,
      1,
      1000
    );

  const ownsClient = !client;
  const dbClient =
    client || await db.getClient();

  try {
    if (ownsClient) {
      await dbClient.query("BEGIN");
    }

    const orderResult =
      await dbClient.query(
        `
          SELECT
            id,
            provider,
            status,
            reconciliation_job_id
          FROM payment_orders
          WHERE id = $1
          FOR UPDATE
        `,
        [normalizedOrderId]
      );

    const order =
      orderResult.rows[0];

    if (!order) {
      throw new Error(
        "payment_order_not_found"
      );
    }

    if (order.provider !== provider) {
      throw new Error(
        "payment_provider_mismatch"
      );
    }

    if (
      [
        "credited",
        "cancelled",
        "expired",
        "rejected",
      ].includes(order.status)
    ) {
      throw new Error(
        "finalized_order_cannot_be_queued"
      );
    }

    const jobResult =
      await dbClient.query(
        `
          INSERT INTO payment_reconciliation_jobs (
            payment_order_id,
            provider,

            job_status,
            priority,

            attempt_count,
            max_attempts,

            next_attempt_at
          )
          VALUES (
            $1,
            $2,

            'queued',
            $3,

            0,
            $4,

            $5
          )

          ON CONFLICT (payment_order_id)
          DO UPDATE SET
            priority =
              LEAST(
                payment_reconciliation_jobs.priority,
                EXCLUDED.priority
              ),

            max_attempts =
              GREATEST(
                payment_reconciliation_jobs.max_attempts,
                EXCLUDED.max_attempts
              ),

            next_attempt_at =
              LEAST(
                payment_reconciliation_jobs.next_attempt_at,
                EXCLUDED.next_attempt_at
              ),

            job_status =
              CASE
                WHEN
                  payment_reconciliation_jobs.job_status
                  IN (
                    'completed',
                    'cancelled'
                  )
                THEN
                  payment_reconciliation_jobs.job_status

                WHEN
                  payment_reconciliation_jobs.job_status =
                  'processing'
                THEN
                  payment_reconciliation_jobs.job_status

                ELSE
                  'queued'
              END,

            last_error_code = NULL,
            last_error_message = NULL,

            updated_at = NOW()

          RETURNING *
        `,
        [
          normalizedOrderId,
          provider,
          normalizedPriority,
          normalizedMaxAttempts,
          nextAttemptAt,
        ]
      );

    const job = jobResult.rows[0];

    await dbClient.query(
      `
        UPDATE payment_orders
        SET
          reconciliation_job_id = $2,
          next_verification_at = $3,
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        normalizedOrderId,
        job.id,
        job.next_attempt_at,
      ]
    );

    if (ownsClient) {
      await dbClient.query("COMMIT");
    }

    return job;
  } catch (error) {
    if (ownsClient) {
      try {
        await dbClient.query("ROLLBACK");
      } catch (_) {
        // Original error preserve হবে।
      }
    }

    throw error;
  } finally {
    if (ownsClient) {
      dbClient.release();
    }
  }
}

/**
 * Ready jobs worker-এর নামে claim করে।
 *
 * FOR UPDATE SKIP LOCKED থাকার কারণে একাধিক worker
 * একই payment order process করতে পারবে না।
 */
async function claimReadyJobs({
  workerId,
  provider = null,
  limit = 25,
}) {
  const normalizedWorkerId =
    normalizeWorkerId(workerId);

  if (provider !== null) {
    assertAutomaticProvider(provider);
  }

  const normalizedLimit =
    normalizeInteger(
      limit,
      25,
      1,
      100
    );

  const client = await db.getClient();

  try {
    await client.query("BEGIN");

    const result =
      await client.query(
        `
          WITH ready_jobs AS (
            SELECT
              prj.id

            FROM payment_reconciliation_jobs prj

            INNER JOIN payment_orders po
              ON po.id =
                 prj.payment_order_id

            WHERE
              prj.job_status IN (
                'queued',
                'retry_wait'
              )

              AND
              prj.next_attempt_at <= NOW()

              AND
              prj.attempt_count <
              prj.max_attempts

              AND
              (
                $1::text IS NULL
                OR prj.provider = $1
              )

              AND
              po.status IN (
                'created',
                'awaiting_payment',
                'payment_detected',
                'confirming',
                'paid',
                'manual_review'
              )

            ORDER BY
              prj.priority ASC,
              prj.next_attempt_at ASC,
              prj.id ASC

            FOR UPDATE
              OF prj
              SKIP LOCKED

            LIMIT $2
          )

          UPDATE payment_reconciliation_jobs prj

          SET
            job_status = 'processing',

            locked_at = NOW(),
            locked_by = $3,

            last_started_at = NOW(),

            attempt_count =
              prj.attempt_count + 1,

            updated_at = NOW()

          FROM ready_jobs rj

          WHERE prj.id = rj.id

          RETURNING prj.*
        `,
        [
          provider,
          normalizedLimit,
          normalizedWorkerId,
        ]
      );

    await client.query("COMMIT");

    return result.rows;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // Original error preserve হবে।
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Job সফলভাবে verify/credit হলে complete।
 */
async function markJobCompleted({
  jobId,
  workerId,
  resultPayload = null,
  client = db,
}) {
  const normalizedJobId =
    normalizePositiveId(
      jobId,
      "job_id"
    );

  const normalizedWorkerId =
    normalizeWorkerId(workerId);

  const { rows } = await client.query(
    `
      UPDATE payment_reconciliation_jobs
      SET
        job_status = 'completed',

        locked_at = NULL,
        locked_by = NULL,

        last_finished_at = NOW(),

        last_error_code = NULL,
        last_error_message = NULL,

        result_payload = $3::jsonb,

        updated_at = NOW()

      WHERE id = $1
        AND job_status = 'processing'
        AND locked_by = $2

      RETURNING *
    `,
    [
      normalizedJobId,
      normalizedWorkerId,
      toJson(resultPayload),
    ]
  );

  return rows[0] || null;
}

/**
 * Temporary error হলে retry schedule করে।
 */
async function markJobForRetry({
  jobId,
  workerId,

  delaySeconds = 30,

  errorCode = null,
  errorMessage = null,

  resultPayload = null,

  client = db,
}) {
  const normalizedJobId =
    normalizePositiveId(
      jobId,
      "job_id"
    );

  const normalizedWorkerId =
    normalizeWorkerId(workerId);

  const normalizedDelaySeconds =
    normalizeInteger(
      delaySeconds,
      30,
      5,
      86400
    );

  const { rows } = await client.query(
    `
      UPDATE payment_reconciliation_jobs
      SET
        job_status =
          CASE
            WHEN attempt_count >= max_attempts
            THEN 'failed'
            ELSE 'retry_wait'
          END,

        next_attempt_at =
          NOW() +
          ($3 * INTERVAL '1 second'),

        locked_at = NULL,
        locked_by = NULL,

        last_finished_at = NOW(),

        last_error_code = $4,
        last_error_message = $5,

        result_payload = $6::jsonb,

        updated_at = NOW()

      WHERE id = $1
        AND job_status = 'processing'
        AND locked_by = $2

      RETURNING *
    `,
    [
      normalizedJobId,
      normalizedWorkerId,
      normalizedDelaySeconds,
      errorCode,
      errorMessage,
      toJson(resultPayload),
    ]
  );

  return rows[0] || null;
}

/**
 * Automatic verification ambiguous হলে manual review।
 */
async function markJobForManualReview({
  jobId,
  workerId,

  reason,
  resultPayload = null,

  client = db,
}) {
  const normalizedJobId =
    normalizePositiveId(
      jobId,
      "job_id"
    );

  const normalizedWorkerId =
    normalizeWorkerId(workerId);

  const normalizedReason =
    String(
      reason ||
      "Automatic verification requires review"
    ).trim().slice(0, 2000);

  const { rows } = await client.query(
    `
      UPDATE payment_reconciliation_jobs
      SET
        job_status = 'manual_review',

        locked_at = NULL,
        locked_by = NULL,

        last_finished_at = NOW(),

        last_error_code =
          'manual_review_required',

        last_error_message = $3,

        result_payload = $4::jsonb,

        updated_at = NOW()

      WHERE id = $1
        AND job_status = 'processing'
        AND locked_by = $2

      RETURNING *
    `,
    [
      normalizedJobId,
      normalizedWorkerId,
      normalizedReason,
      toJson(resultPayload),
    ]
  );

  return rows[0] || null;
}

/**
 * Permanent failure হলে failed।
 */
async function markJobFailed({
  jobId,
  workerId,

  errorCode,
  errorMessage,

  resultPayload = null,

  client = db,
}) {
  const normalizedJobId =
    normalizePositiveId(
      jobId,
      "job_id"
    );

  const normalizedWorkerId =
    normalizeWorkerId(workerId);

  const { rows } = await client.query(
    `
      UPDATE payment_reconciliation_jobs
      SET
        job_status = 'failed',

        locked_at = NULL,
        locked_by = NULL,

        last_finished_at = NOW(),

        last_error_code = $3,
        last_error_message = $4,

        result_payload = $5::jsonb,

        updated_at = NOW()

      WHERE id = $1
        AND job_status = 'processing'
        AND locked_by = $2

      RETURNING *
    `,
    [
      normalizedJobId,
      normalizedWorkerId,
      errorCode,
      errorMessage,
      toJson(resultPayload),
    ]
  );

  return rows[0] || null;
}

/**
 * Worker crash হলে পুরোনো processing lock recover করে।
 */
async function recoverStaleJobs({
  staleAfterSeconds = 300,
  limit = 100,
  client = db,
}) {
  const normalizedStaleSeconds =
    normalizeInteger(
      staleAfterSeconds,
      300,
      30,
      86400
    );

  const normalizedLimit =
    normalizeInteger(
      limit,
      100,
      1,
      1000
    );

  const { rows } = await client.query(
    `
      WITH stale_jobs AS (
        SELECT id

        FROM payment_reconciliation_jobs

        WHERE job_status = 'processing'

          AND locked_at <
              NOW() -
              ($1 * INTERVAL '1 second')

        ORDER BY locked_at ASC

        LIMIT $2

        FOR UPDATE SKIP LOCKED
      )

      UPDATE payment_reconciliation_jobs prj

      SET
        job_status =
          CASE
            WHEN
              prj.attempt_count >=
              prj.max_attempts
            THEN 'failed'
            ELSE 'retry_wait'
          END,

        next_attempt_at = NOW(),

        locked_at = NULL,
        locked_by = NULL,

        last_finished_at = NOW(),

        last_error_code =
          'worker_lock_expired',

        last_error_message =
          'Previous reconciliation worker lock expired',

        updated_at = NOW()

      FROM stale_jobs sj

      WHERE prj.id = sj.id

      RETURNING prj.*
    `,
    [
      normalizedStaleSeconds,
      normalizedLimit,
    ]
  );

  return rows;
}

/**
 * Job এবং linked payment order একসঙ্গে fetch।
 */
async function getJobWithOrder({
  jobId,
  client = db,
}) {
  const normalizedJobId =
    normalizePositiveId(
      jobId,
      "job_id"
    );

  const { rows } = await client.query(
    `
      SELECT
        prj.*,

        po.order_reference,
        po.user_id,
        po.status AS payment_status,

        po.requested_amount_usd,
        po.requested_amount_microusd,

        po.asset,
        po.network,

        po.expected_crypto_amount,
        po.destination_address,
        po.destination_tag,

        po.provider_order_id,
        po.provider_transaction_id,
        po.tx_hash,

        po.crypto_payment_method_id,
        po.expires_at,

        po.metadata AS payment_metadata

      FROM payment_reconciliation_jobs prj

      INNER JOIN payment_orders po
        ON po.id =
           prj.payment_order_id

      WHERE prj.id = $1

      LIMIT 1
    `,
    [normalizedJobId]
  );

  return rows[0] || null;
}

module.exports = {
  enqueueJob,
  claimReadyJobs,

  markJobCompleted,
  markJobForRetry,
  markJobForManualReview,
  markJobFailed,

  recoverStaleJobs,

  getJobWithOrder,
};