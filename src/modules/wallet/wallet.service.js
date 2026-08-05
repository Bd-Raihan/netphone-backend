const db = require("../../config/db");
const MICRO_USD_PER_USD = 1_000_000;
const MICRO_USD_PER_CENT = 10_000;

function toSafeInteger(value, fallback = 0) {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    return fallback;
  }

  return parsed;
}

function centsToMicroUsd(amountCents) {
  return (
    toSafeInteger(amountCents, 0) *
    MICRO_USD_PER_CENT
  );
}

function microUsdToLegacyCents(amountMicroUsd) {
  const safeAmount =
    Math.max(
      0,
      toSafeInteger(amountMicroUsd, 0)
    );

  /*
   * Legacy cents field শুধু compatibility/display fallback।
   * Primary exact ledger নয়।
   */
  return Math.round(
    safeAmount / MICRO_USD_PER_CENT
  );
}

function microUsdToUsd(amountMicroUsd) {
  return (
    toSafeInteger(amountMicroUsd, 0) /
    MICRO_USD_PER_USD
  );
}
async function getWalletByUserId(userId) {
  const { rows } = await db.query(
    `
      SELECT
        user_id,
        currency,
        balance_cents,
        balance_microusd,

        (
          balance_microusd::numeric /
          1000000
        )::numeric(20,7) AS balance_usd,

        updated_at

      FROM wallets
      WHERE user_id = $1
      LIMIT 1
    `,
    [userId]
  );

  return rows[0] || null;
}

// ✅ ensure wallet row exists (সেফটি)
async function ensureWallet(
  userId,
  currency = "USD"
) {
  await db.query(
    `
      INSERT INTO wallets (
        user_id,
        currency,
        balance_cents,
        balance_microusd
      )
      VALUES (
        $1,
        $2,
        0,
        0
      )
      ON CONFLICT (user_id)
      DO NOTHING
    `,
    [userId, currency]
  );

  return getWalletByUserId(userId);
}

// ✅ transaction apply (atomic) — balance update + tx insert
// ✅ transaction apply (atomic) — balance update + tx insert
async function applyWalletTx({
  userId,
  currency = "USD",

  /*
   * নতুন exact input।
   */
  amountMicroUsd,

  /*
   * পুরোনো controller/recharge/transfer compatibility।
   */
  amountCents,

  txType,
  direction,

  idempotencyKey = null,
  meta = null,
}) {
  const finalTxType =
    txType ||
    (
      direction === "credit"
        ? "admin_credit"
        : direction === "debit"
        ? "admin_debit"
        : null
    );

  if (!finalTxType) {
    throw new Error("tx_type_missing");
  }

  const normalizedUserId =
    Number(userId);

  if (
    !Number.isInteger(normalizedUserId) ||
    normalizedUserId <= 0
  ) {
    throw new Error("invalid_user_id");
  }

  /*
   * Exact micro-USD থাকলে সেটিই primary।
   * না থাকলে পুরোনো cents input convert হবে।
   */
  const normalizedAmountMicroUsd =
    amountMicroUsd !== undefined &&
    amountMicroUsd !== null
      ? toSafeInteger(amountMicroUsd, 0)
      : centsToMicroUsd(amountCents);

  if (normalizedAmountMicroUsd <= 0) {
    throw new Error("invalid_transaction_amount");
  }

  const legacyAmountCents =
    amountCents !== undefined &&
    amountCents !== null
      ? Math.abs(
          toSafeInteger(amountCents, 0)
        )
      : microUsdToLegacyCents(
          normalizedAmountMicroUsd
        );

  const client =
    await db.getClient();

  try {
    await client.query("BEGIN");

    await client.query(
      `
        INSERT INTO wallets (
          user_id,
          currency,
          balance_cents,
          balance_microusd
        )
        VALUES (
          $1,
          $2,
          0,
          0
        )
        ON CONFLICT (user_id)
        DO NOTHING
      `,
      [
        normalizedUserId,
        currency,
      ]
    );

    const walletResult =
      await client.query(
        `
          SELECT
            user_id,
            currency,
            balance_cents,
            balance_microusd
          FROM wallets
          WHERE user_id = $1
          FOR UPDATE
        `,
        [normalizedUserId]
      );

    const wallet =
      walletResult.rows[0];

    if (!wallet) {
      throw new Error("wallet_missing");
    }

    /*
     * Migration-এর পরেও safety fallback।
     */
    const currentBalanceMicroUsd =
      wallet.balance_microusd !== null &&
      wallet.balance_microusd !== undefined
        ? toSafeInteger(
            Number(wallet.balance_microusd),
            0
          )
        : centsToMicroUsd(
            wallet.balance_cents
          );

    if (idempotencyKey) {
      const existingResult =
        await client.query(
          `
            SELECT
              id,
              user_id,
              type,
              amount_cents,
              amount_microusd,
              status,
              balance_after_cents,
              balance_after_microusd,
              created_at,
              meta,

              (
                amount_microusd::numeric /
                1000000
              )::numeric(20,7)
                AS amount_usd,

              (
                balance_after_microusd::numeric /
                1000000
              )::numeric(20,7)
                AS balance_after_usd

            FROM wallet_transactions
            WHERE user_id = $1
              AND idempotency_key = $2
            LIMIT 1
          `,
          [
            normalizedUserId,
            idempotencyKey,
          ]
        );

      if (existingResult.rows[0]) {
        await client.query("COMMIT");

        return {
          ok: true,
          duplicated: true,
          wallet:
            await getWalletByUserId(
              normalizedUserId
            ),
          tx: existingResult.rows[0],
        };
      }
    }

    const creditTypes = new Set([
      "admin_credit",
      "recharge",
      "refund",
      "transfer_received",
      "transfer_in",
    ]);

    const debitTypes = new Set([
      "admin_debit",
      "call_charge",
      "withdraw",
      "transfer_sent",
      "transfer_out",
    ]);

    let newBalanceMicroUsd;

    if (creditTypes.has(finalTxType)) {
      newBalanceMicroUsd =
        currentBalanceMicroUsd +
        normalizedAmountMicroUsd;
    } else if (debitTypes.has(finalTxType)) {
      newBalanceMicroUsd =
        currentBalanceMicroUsd -
        normalizedAmountMicroUsd;
    } else {
      throw new Error(
        "unknown_transaction_type"
      );
    }

    if (newBalanceMicroUsd < 0) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason: "insufficient_balance",
      };
    }

    /*
     * Legacy balance_cents exact ledger নয়।
     * Existing পুরোনো screen/API ভাঙা রোধে derived field।
     */
    const newBalanceCents =
      microUsdToLegacyCents(
        newBalanceMicroUsd
      );

    const metaJson =
      meta
        ? JSON.stringify({
            ...meta,

            exact_wallet_amount: {
              amount_microusd:
                normalizedAmountMicroUsd,

              amount_usd:
                microUsdToUsd(
                  normalizedAmountMicroUsd
                ),

              balance_after_microusd:
                newBalanceMicroUsd,

              balance_after_usd:
                microUsdToUsd(
                  newBalanceMicroUsd
                ),
            },
          })
        : JSON.stringify({
            exact_wallet_amount: {
              amount_microusd:
                normalizedAmountMicroUsd,

              amount_usd:
                microUsdToUsd(
                  normalizedAmountMicroUsd
                ),

              balance_after_microusd:
                newBalanceMicroUsd,

              balance_after_usd:
                microUsdToUsd(
                  newBalanceMicroUsd
                ),
            },
          });

    const transactionResult =
      await client.query(
        `
          INSERT INTO wallet_transactions (
            user_id,
            type,

            amount_cents,
            amount_microusd,

            status,
            idempotency_key,

            balance_after_cents,
            balance_after_microusd,

            meta
          )
          VALUES (
            $1,
            $2,

            $3,
            $4,

            'posted',
            $5,

            $6,
            $7,

            $8::jsonb
          )
          RETURNING
            id,
            user_id,
            type,

            amount_cents,
            amount_microusd,

            status,

            balance_after_cents,
            balance_after_microusd,

            created_at,
            meta,

            (
              amount_microusd::numeric /
              1000000
            )::numeric(20,7)
              AS amount_usd,

            (
              balance_after_microusd::numeric /
              1000000
            )::numeric(20,7)
              AS balance_after_usd
        `,
        [
          normalizedUserId,
          finalTxType,

          legacyAmountCents,
          normalizedAmountMicroUsd,

          idempotencyKey,

          newBalanceCents,
          newBalanceMicroUsd,

          metaJson,
        ]
      );

    await client.query(
      `
        UPDATE wallets
        SET
          balance_microusd = $2,
          balance_cents = $3,
          updated_at = NOW()
        WHERE user_id = $1
      `,
      [
        normalizedUserId,
        newBalanceMicroUsd,
        newBalanceCents,
      ]
    );

    await client.query("COMMIT");

    return {
      ok: true,

      wallet:
        await getWalletByUserId(
          normalizedUserId
        ),

      tx:
        transactionResult.rows[0],
    };
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
 * Payment Engine transaction-aware wallet operation.
 *
 * গুরুত্বপূর্ণ:
 * - এটি নিজে BEGIN / COMMIT / ROLLBACK করে না।
 * - caller থেকে পাওয়া একই PostgreSQL client ব্যবহার করে।
 * - Payment order, wallet credit এবং crypto history একই
 *   database transaction-এর মধ্যে রাখা যাবে।
 */
async function applyWalletTxWithClient({
  client,

  userId,
  currency = "USD",

  amountMicroUsd,
  amountCents,

  txType,
  direction,

  idempotencyKey = null,
  reference = null,
  meta = null,
}) {
  if (
    !client ||
    typeof client.query !== "function"
  ) {
    throw new Error("database_client_required");
  }

  const finalTxType =
    txType ||
    (
      direction === "credit"
        ? "admin_credit"
        : direction === "debit"
        ? "admin_debit"
        : null
    );

  if (!finalTxType) {
    throw new Error("tx_type_missing");
  }

  const normalizedUserId =
    Number(userId);

  if (
    !Number.isInteger(normalizedUserId) ||
    normalizedUserId <= 0
  ) {
    throw new Error("invalid_user_id");
  }

  const normalizedAmountMicroUsd =
    amountMicroUsd !== undefined &&
    amountMicroUsd !== null
      ? toSafeInteger(
          amountMicroUsd,
          0
        )
      : centsToMicroUsd(
          amountCents
        );

  if (
    normalizedAmountMicroUsd <= 0
  ) {
    throw new Error(
      "invalid_transaction_amount"
    );
  }

  const legacyAmountCents =
    amountCents !== undefined &&
    amountCents !== null
      ? Math.abs(
          toSafeInteger(
            amountCents,
            0
          )
        )
      : microUsdToLegacyCents(
          normalizedAmountMicroUsd
        );

  /*
   * Wallet না থাকলে একই transaction-এর মধ্যে তৈরি হবে।
   */
  await client.query(
    `
      INSERT INTO wallets (
        user_id,
        currency,
        balance_cents,
        balance_microusd
      )
      VALUES (
        $1,
        $2,
        0,
        0
      )
      ON CONFLICT (user_id)
      DO NOTHING
    `,
    [
      normalizedUserId,
      currency,
    ]
  );

  /*
   * Wallet row lock।
   */
  const walletResult =
    await client.query(
      `
        SELECT
          user_id,
          currency,
          balance_cents,
          balance_microusd,
          updated_at
        FROM wallets
        WHERE user_id = $1
        FOR UPDATE
      `,
      [normalizedUserId]
    );

  const wallet =
    walletResult.rows[0];

  if (!wallet) {
    throw new Error("wallet_missing");
  }

  /*
   * একই payment/order আগে credit হয়ে থাকলে
   * দ্বিতীয়বার balance পরিবর্তন হবে না।
   */
  if (idempotencyKey) {
    const existingResult =
      await client.query(
        `
          SELECT
            id,
            user_id,
            type,

            amount_cents,
            amount_microusd,

            reference,
            idempotency_key,
            status,

            balance_after_cents,
            balance_after_microusd,

            created_at,
            meta,

            (
              amount_microusd::numeric /
              1000000
            )::numeric(20,7)
              AS amount_usd,

            (
              balance_after_microusd::numeric /
              1000000
            )::numeric(20,7)
              AS balance_after_usd

          FROM wallet_transactions

          WHERE user_id = $1
            AND idempotency_key = $2

          LIMIT 1
        `,
        [
          normalizedUserId,
          idempotencyKey,
        ]
      );

    if (existingResult.rows[0]) {
      return {
        ok: true,
        duplicated: true,

        wallet: {
          ...wallet,

          balance_usd:
            microUsdToUsd(
              toSafeInteger(
                wallet.balance_microusd,
                0
              )
            ),
        },

        tx:
          existingResult.rows[0],
      };
    }
  }

  const currentBalanceMicroUsd =
    wallet.balance_microusd !== null &&
    wallet.balance_microusd !== undefined
      ? toSafeInteger(
          Number(
            wallet.balance_microusd
          ),
          0
        )
      : centsToMicroUsd(
          wallet.balance_cents
        );

  const creditTypes = new Set([
    "admin_credit",
    "recharge",
    "refund",
    "transfer_received",
    "transfer_in",
  ]);

  const debitTypes = new Set([
    "admin_debit",
    "call_charge",
    "withdraw",
    "transfer_sent",
    "transfer_out",
  ]);

  let newBalanceMicroUsd;

  if (
    creditTypes.has(finalTxType)
  ) {
    newBalanceMicroUsd =
      currentBalanceMicroUsd +
      normalizedAmountMicroUsd;
  } else if (
    debitTypes.has(finalTxType)
  ) {
    newBalanceMicroUsd =
      currentBalanceMicroUsd -
      normalizedAmountMicroUsd;
  } else {
    throw new Error(
      "unknown_transaction_type"
    );
  }

  if (newBalanceMicroUsd < 0) {
    return {
      ok: false,
      reason: "insufficient_balance",
    };
  }

  const newBalanceCents =
    microUsdToLegacyCents(
      newBalanceMicroUsd
    );

  const finalReference =
    reference ||
    (
      idempotencyKey
        ? String(idempotencyKey)
        : null
    );

  const metaJson =
    JSON.stringify({
      ...(meta || {}),

      exact_wallet_amount: {
        amount_microusd:
          normalizedAmountMicroUsd,

        amount_usd:
          microUsdToUsd(
            normalizedAmountMicroUsd
          ),

        balance_after_microusd:
          newBalanceMicroUsd,

        balance_after_usd:
          microUsdToUsd(
            newBalanceMicroUsd
          ),
      },
    });

  const transactionResult =
    await client.query(
      `
        INSERT INTO wallet_transactions (
          user_id,
          type,

          amount_cents,
          amount_microusd,

          reference,
          idempotency_key,

          status,

          balance_after_cents,
          balance_after_microusd,

          meta
        )
        VALUES (
          $1,
          $2,

          $3,
          $4,

          $5,
          $6,

          'posted',

          $7,
          $8,

          $9::jsonb
        )
        RETURNING
          id,
          user_id,
          type,

          amount_cents,
          amount_microusd,

          reference,
          idempotency_key,
          status,

          balance_after_cents,
          balance_after_microusd,

          created_at,
          meta,

          (
            amount_microusd::numeric /
            1000000
          )::numeric(20,7)
            AS amount_usd,

          (
            balance_after_microusd::numeric /
            1000000
          )::numeric(20,7)
            AS balance_after_usd
      `,
      [
        normalizedUserId,
        finalTxType,

        legacyAmountCents,
        normalizedAmountMicroUsd,

        finalReference,
        idempotencyKey,

        newBalanceCents,
        newBalanceMicroUsd,

        metaJson,
      ]
    );

  const updatedWalletResult =
    await client.query(
      `
        UPDATE wallets
        SET
          balance_microusd = $2,
          balance_cents = $3,
          updated_at = NOW()
        WHERE user_id = $1
        RETURNING
          user_id,
          currency,
          balance_cents,
          balance_microusd,

          (
            balance_microusd::numeric /
            1000000
          )::numeric(20,7)
            AS balance_usd,

          updated_at
      `,
      [
        normalizedUserId,
        newBalanceMicroUsd,
        newBalanceCents,
      ]
    );

  return {
    ok: true,
    duplicated: false,

    wallet:
      updatedWalletResult.rows[0],

    tx:
      transactionResult.rows[0],
  };
}

async function listTransactions(
  userId,
  limit = 20
) {
  const { rows } = await db.query(
    `
      SELECT
        id,
        type,

        amount_cents,
        amount_microusd,

        status,

        balance_after_cents,
        balance_after_microusd,

        created_at,
        meta,

        COALESCE(
          (
            amount_microusd::numeric /
            1000000
          ),
          (
            amount_cents::numeric /
            100
          )
        )::numeric(20,7)
          AS amount_usd,

        COALESCE(
          (
            balance_after_microusd::numeric /
            1000000
          ),
          (
            balance_after_cents::numeric /
            100
          )
        )::numeric(20,7)
          AS balance_after_usd

      FROM wallet_transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [
      userId,
      limit,
    ]
  );

  return rows;
}


// ✅ Compatibility wrapper (পুরাতন controller/routes ভাঙবে না)
async function creditWallet({ userId, amountCents, currency, meta }) {
  return applyWalletTx({
    userId,
    amountCents,
    currency,
    txType: "admin_credit", // ✅ এখানে type fix
    meta,
  });
}

async function debitWallet({ userId, amountCents, currency, meta }) {
  return applyWalletTx({
    userId,
    amountCents,
    currency,
    txType: "admin_debit", // ✅ এখানে type fix
    meta,
  });
}



module.exports = {
  getWalletByUserId,
  ensureWallet,
  applyWalletTx,
  applyWalletTxWithClient,
  listTransactions,
  creditWallet,
  debitWallet,
};
