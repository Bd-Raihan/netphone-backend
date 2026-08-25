/// =====================================
/// TRANSFER COOLDOWN MEMORY
/// userId => timestamp
/// =====================================
const transferCooldown = {}; // In-memory object to track transfer cooldowns

const db = require("../../config/db"); // Database connection
const walletService = require("./wallet.service"); // Wallet related business logic
const ratesService = require("../rates/rates.service"); // Dynamic final sell rates

/// ===============================
/// GET /wallet/me
/// User নিজের wallet
/// ===============================
async function me(req, res) {
  try {
    const userId =
      Number(req.user?.id);

    if (
      !Number.isInteger(userId) ||
      userId <= 0
    ) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized user",
      });
    }

    await walletService.ensureWallet(
      userId,
      "USD"
    );

    const { rows } = await db.query(
      `
        SELECT
          w.user_id,
          w.currency,

          w.balance_cents,
          w.balance_microusd,

          (
            w.balance_microusd::numeric /
            1000000
          )::numeric(20,7)
            AS balance_usd,

          w.updated_at,

          u.phone_e164,

          estimate.country_code
            AS estimate_country_code,

          estimate.country_name
            AS estimate_country_name,

          estimate.phone_prefix
            AS estimate_phone_prefix,

          estimate.estimate_rate_usd_per_min

        FROM wallets w

        JOIN users u
          ON u.id = w.user_id

        LEFT JOIN LATERAL (
          SELECT
            wer.country_code,
            wer.country_name,
            wer.phone_prefix,
            wer.estimate_rate_usd_per_min
          FROM wallet_estimate_rates wer
          WHERE wer.is_active = TRUE
            AND REPLACE(
                  u.phone_e164,
                  '+',
                  ''
                ) LIKE
                wer.phone_prefix || '%'
          ORDER BY
            LENGTH(wer.phone_prefix) DESC,
            wer.id ASC
          LIMIT 1
        ) estimate
          ON TRUE

        WHERE w.user_id = $1
        LIMIT 1
      `,
      [userId]
    );

    if (!rows.length) {
      return res.status(404).json({
        ok: false,
        message: "Wallet not found",
      });
    }

    const row = rows[0];

    /*
     * Wallet estimated call rate now follows the same
     * dynamic Final Sell Rate published by Admin Country Pricing.
     *
     * No country rate is hardcoded here.
     *
     * Matching rule:
     * - Take the user's registered E.164 phone number.
     * - Compare it with all published pricing prefixes.
     * - Use the longest matching prefix.
     *
     * Example:
     * +88017...
     * may match 880 and 88017.
     * The longest matching prefix wins.
     *
     * The old wallet_estimate_rates value remains only
     * as a safe production fallback if no current
     * Admin Country Pricing rate can be resolved.
     */

   const dynamicRate =
  await ratesService
    .getPublicRateByPhone(
      row.phone_e164
    );

    const dynamicEstimateRate =
      Number(
        dynamicRate?.sell_rate_usd_per_min
      );

    const legacyEstimateRate =
      Number(
        row.estimate_rate_usd_per_min
      );

    const hasDynamicEstimateRate =
      Number.isFinite(
        dynamicEstimateRate
      ) &&
      dynamicEstimateRate > 0;

    const hasLegacyEstimateRate =
      Number.isFinite(
        legacyEstimateRate
      ) &&
      legacyEstimateRate > 0;

    const estimateRate =
      hasDynamicEstimateRate
        ? dynamicEstimateRate
        : hasLegacyEstimateRate
        ? legacyEstimateRate
        : 0;

    const estimateCountryCode =
      hasDynamicEstimateRate
        ? dynamicRate?.country_code || null
        : row.estimate_country_code;

    const estimateCountryName =
      hasDynamicEstimateRate
        ? dynamicRate?.country_name || null
        : row.estimate_country_name;

    const estimatePhonePrefix =
      hasDynamicEstimateRate
        ? String(
            dynamicRate?.prefix || ""
          ).replace(/^\+/, "")
        : row.estimate_phone_prefix;

    const estimateRateSource =
      hasDynamicEstimateRate
        ? "admin_country_pricing_final_sell_rate"
        : hasLegacyEstimateRate
        ? "registered_country_stable_rate_fallback"
        : null;

    return res.json({
      ok: true,

      wallet: {
        user_id:
          row.user_id,

        currency:
          row.currency,

        balance_cents:
          row.balance_cents,

        balance_microusd:
          row.balance_microusd,

        balance_usd:
          row.balance_usd,

        updated_at:
          row.updated_at,
      },

      estimated_call_rate:
        Number.isFinite(estimateRate) &&
        estimateRate > 0
          ? {
              sell_rate_usd_per_min:
                estimateRate,

              country_code:
                estimateCountryCode,

              country_name:
                estimateCountryName,

              phone_prefix:
                estimatePhonePrefix,

              rate_source:
                estimateRateSource,
            }
          : null,
    });
  } catch (error) {
    console.error(
      "wallet/me error:",
      error
    );

    return res.status(500).json({
      ok: false,

      message:
        error.message ||
        "Unable to load wallet",
    });
  }
}

/// ===============================
/// GET /wallet/tx
/// User transactions
/// ===============================
async function tx(req, res) {
  try {
    const userId =
      Number(req.user?.id);

    const limit =
      Math.min(
        Math.max(
          Number(req.query.limit || 20),
          1
        ),
        100
      );

    const items =
      await walletService.listTransactions(
        userId,
        limit
      );

    return res.json({
      ok: true,
      items,
      transactions: items,
    });
  } catch (error) {
    console.error(
      "wallet/tx error:",
      error
    );

    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
}

/// ===============================
/// POST /wallet/credit
/// কাজ:
/// - শুধু admin recharge করতে পারবে
/// - phone number দিয়ে user খুঁজবে
/// - amount add করবে
/// - transaction history save হবে
/// ===============================
async function credit(req, res) {
  try {

    /// =====================================
    /// STEP 1:
    /// Login করা user admin কিনা check
    /// যদি admin না হয় → recharge block
    /// =====================================
    if (req.user.role !== "admin") {
      return res.status(403).json({
        ok: false,
        message: "Admin only recharge",
      });
    }

    /// =====================================
    /// STEP 2:
    /// Request body থেকে data নেওয়া
    ///
    /// phone_e164 = যাকে recharge দিব
    /// amount_cents = কত টাকা add হবে
    /// currency = USD
    /// meta = extra info
    /// =====================================
    const phone =
      req.body.phone_e164;

    const amountCents =
      Number(req.body.amount_cents);

    const currency =
      (req.body.currency || "USD")
        .toUpperCase();

    const meta =
      req.body.meta || {};

    /// =====================================
    /// STEP 3:
    /// phone empty হলে error
    /// =====================================
    if (!phone) {
      return res.status(400).json({
        ok: false,
        message: "Phone number required",
      });
    }

    /// =====================================
    /// STEP 4:
    /// amount ভুল হলে error
    /// =====================================
    if (
      !Number.isFinite(amountCents) ||
      amountCents <= 0
    ) {
      return res.status(400).json({
        ok: false,
        message: "Invalid amount",
      });
    }

    /// =====================================
    /// STEP 5:
    /// users table থেকে phone দিয়ে user খুঁজবে
    /// =====================================
    const userQ = `
      SELECT id, phone_e164
      FROM users
      WHERE phone_e164 = $1
      LIMIT 1
    `;

    const userResult =
      await db.query(
        userQ,
        [phone]
      );

    /// =====================================
    /// STEP 6:
    /// phone registered না থাকলে error
    /// =====================================
    if (!userResult.rows.length) {
      return res.status(404).json({
        ok: false,
        message: "User not found",
      });
    }

    /// =====================================
    /// STEP 7:
    /// user পাওয়া গেলে তার ID নেওয়া
    /// =====================================
    const userId =
      Number(
        userResult.rows[0].id
      );

    /// =====================================
    /// STEP 8:
    /// wallet service call
    /// টাকা add হবে
    /// =====================================
    const result =
      await walletService.creditWallet({
        userId,
        amountCents,
        currency,

        /// =================================
        /// meta history এর জন্য save হবে
        /// কে recharge দিল
        /// কোন phone এ দিল
        /// =================================
        meta: {
          ...meta,
          phone_e164: phone,
          recharged_by_admin:
            req.user.phone,
        },
      });

    /// =====================================
    /// STEP 9:
    /// success response
    /// =====================================
    return res.json({
      ok: true,
      tx: result.tx,
      wallet: result.wallet,
    });

  } catch (e) {
    console.error(
      "wallet/credit error:",
      e
    );

    /// =====================================
    /// STEP 10:
    /// unexpected error
    /// =====================================
    return res.status(500).json({
      ok: false,
      message: e.message,
    });
  }
}

/// ===============================
/// POST /wallet/debit
/// Call charge কাটবে
/// ===============================
async function debit(req, res) {
  try {
    const userId =
      Number(
        req.body.user_id ||
        req.user.id
      );

    const amountCents =
      Number(
        req.body.amount_cents
      );

    const currency =
      (
        req.body.currency ||
        "USD"
      ).toUpperCase();

    const meta =
      req.body.meta || {};

    if (
      !Number.isFinite(amountCents) ||
      amountCents <= 0
    ) {
      return res.status(400).json({
        ok: false,
        message: "Invalid input",
      });
    }

    const result =
      await walletService.debitWallet({
        userId,
        amountCents,
        currency,
        meta,
      });

    return res.json({
      ok: true,
      tx: result.tx,
      wallet: result.wallet,
    });

  } catch (e) {
    console.error(
      "wallet/debit error:",
      e
    );

    return res.status(500).json({
      ok: false,
      message: e.message,
    });
  }
}

/// ===============================================
/// POST /wallet/transfer
///
/// কাজ:
/// - User অন্য user কে balance transfer করবে
/// - Sender balance থেকে টাকা কাটবে
/// - Receiver balance এ টাকা যোগ হবে
/// - দুই side transaction history save হবে
/// ===============================================
async function transferBalance(
  req,
  res
) {
  try {

    /// =====================================
    /// STEP 1:
    /// Login করা sender user
    /// =====================================
    const senderUserId =
      Number(req.user.id);

    /// =====================================
    /// STEP 1.1:
    /// Transfer cooldown check
    /// 30 second wait required
    /// =====================================
    const now =
      Date.now();

    const lastTransfer =
      transferCooldown[
        senderUserId
      ];

    /// যদি last transfer থাকে
    if (lastTransfer) {

      const diffSeconds =
        (
          now -
          lastTransfer
        ) / 1000;

      console.log(
        "Cooldown Seconds:",
        diffSeconds
      );

      /// 30 second এর কম হলে block
      if (diffSeconds < 30) {
        return res
          .status(429)
          .json({
            ok: false,

            message:
              `Please wait ${Math.ceil(
                30 -
                diffSeconds
              )} seconds`,
          });
      }
    }

    /// sender phone
    const senderPhone =
      req.user.phone;

    /// =====================================
    /// STEP 2:
    /// Request body থেকে data নেওয়া
    /// =====================================
    const receiverPhone =
      req.body.phone_e164;

    const amountCents =
      Number(
        req.body.amount_cents
      );

    const currency =
      (
        req.body.currency ||
        "USD"
      ).toUpperCase();

    /// =====================================
    /// STEP 3:
    /// Validation
    /// =====================================

    /// receiver phone empty হলে
    if (!receiverPhone) {
      return res.status(400).json({
        ok: false,
        message:
          "Receiver phone required",
      });
    }

    /// amount invalid হলে
    if (
      !Number.isFinite(
        amountCents
      ) ||
      amountCents <= 0
    ) {
      return res.status(400).json({
        ok: false,
        message: "Invalid amount",
      });
    }

    /// =====================================
    /// STEP 3.1:
    /// Minimum transfer amount
    /// 100 fils এর কম transfer হবে না
    /// =====================================
    if (amountCents < 100) {
      return res.status(400).json({
        ok: false,
        message:
          "Minimum transfer is 0.100 USD",
      });
    }

    /// =====================================
    /// STEP 3.2:
    /// Maximum transfer limit
    /// একবারে 50 USD এর বেশি যাবে না
    /// =====================================
    if (amountCents > 50000) {
      return res.status(400).json({
        ok: false,
        message:
          "Maximum transfer is 50 USD",
      });
    }

    /// =====================================
    /// STEP 4:
    /// Receiver user খুঁজবে
    /// =====================================
    const receiverQ = `
      SELECT id, phone_e164
      FROM users
      WHERE phone_e164 = $1
      LIMIT 1
    `;

    const receiverResult =
      await db.query(
        receiverQ,
        [receiverPhone]
      );

    /// receiver না থাকলে error
    if (
      !receiverResult.rows.length
    ) {
      return res.status(404).json({
        ok: false,
        message:
          "Receiver not found",
      });
    }

    /// =====================================
    /// STEP 5:
    /// Receiver user পাওয়া গেছে
    /// =====================================
    const receiverUser =
      receiverResult.rows[0];

    const receiverUserId =
      Number(
        receiverUser.id
      );

    /// =====================================
    /// STEP 6:
    /// Self transfer block
    /// =====================================
    if (
      senderUserId ===
      receiverUserId
    ) {
      return res.status(400).json({
        ok: false,
        message:
          "You cannot transfer to yourself",
      });
    }

    /// =====================================
    /// STEP 7:
    /// Sender wallet থেকে টাকা কাটবে
    ///
    /// transaction type:
    /// transfer_sent
    /// =====================================
    const senderDebit =
      await walletService.applyWalletTx({

        userId:
          senderUserId,

        amountCents,

        currency,

        txType:
          "transfer_sent",

        meta: {
          sender_phone:
            senderPhone,

          receiver_phone:
            receiverPhone,
        },
      });

    /// insufficient balance
    if (!senderDebit.ok) {
      return res.status(400).json({
        ok: false,
        message:
          senderDebit.reason ||
          "Transfer failed",
      });
    }

    /// =====================================
    /// STEP 8:
    /// Receiver wallet এ টাকা add হবে
    ///
    /// transaction type:
    /// transfer_received
    /// =====================================
    const receiverCredit =
      await walletService.applyWalletTx({

        userId:
          receiverUserId,

        amountCents,

        currency,

        txType:
          "transfer_received",

        meta: {
          sender_phone:
            senderPhone,

          receiver_phone:
            receiverPhone,
        },
      });

    /// =====================================
    /// STEP 8.1:
    /// Save transfer timestamp
    /// =====================================
    transferCooldown[
      senderUserId
    ] =
      Date.now();

    /// =====================================
    /// STEP 9:
    /// Success response
    /// =====================================
    return res.json({
      ok: true,

      message:
        "Balance transferred successfully",

      sender_wallet:
        senderDebit.wallet,

      receiver_wallet:
        receiverCredit.wallet,
    });

  } catch (e) {
    console.error(
      "wallet/transfer error:",
      e
    );

    /// =====================================
    /// STEP 10:
    /// Unexpected server error
    /// =====================================
    return res.status(500).json({
      ok: false,
      message: e.message,
    });
  }
}

// Export controller functions
module.exports = {
  me,
  tx,
  credit,
  debit,
  transferBalance,
};