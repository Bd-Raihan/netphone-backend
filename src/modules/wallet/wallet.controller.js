/// =====================================
/// TRANSFER COOLDOWN MEMORY
/// userId => timestamp
/// =====================================
const transferCooldown = {}; // In-memory object to track transfer cooldowns

const db = require("../../config/db"); // Database connection
const walletService = require("./wallet.service"); // Wallet related business logic

/// ===============================
/// GET /wallet/me
/// User নিজের wallet
/// ===============================
async function me(req, res) {
  try {
    const userId = Number(req.user.id);

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

    /*
     * Wallet balance-এর সঙ্গে user-এর সর্বশেষ valid
     * destination sell rate নেওয়া হচ্ছে।
     *
     * এতে app reinstall, logout/login বা device change হলেও
     * estimated minutes হারাবে না।
     */
    const q = `
      SELECT
        w.user_id,
        w.currency,
        w.balance_cents,
        w.updated_at,

        latest_call.id
          AS latest_call_session_id,

        latest_call.to_phone_e164
          AS latest_call_to_phone_e164,

        latest_call.sell_rate_usd_per_min
          AS latest_sell_rate_usd_per_min,

        latest_call.created_at
          AS latest_call_created_at,

        latest_call.meta->>'matched_prefix'
          AS latest_matched_prefix

      FROM wallets w

      LEFT JOIN LATERAL
      (
        SELECT
          cs.id,
          cs.to_phone_e164,
          cs.sell_rate_usd_per_min,
          cs.created_at,
          cs.meta

        FROM call_sessions cs

        WHERE cs.user_id = w.user_id

          AND cs.sell_rate_usd_per_min
                IS NOT NULL

          AND cs.sell_rate_usd_per_min > 0

          AND COALESCE(
                cs.status,
                ''
              ) <> 'failed'

        ORDER BY
          cs.created_at DESC,
          cs.id DESC

        LIMIT 1
      ) latest_call
        ON TRUE

      WHERE w.user_id = $1

      LIMIT 1;
    `;

    const { rows } =
      await db.query(q, [userId]);

    if (!rows.length) {
      return res.status(404).json({
        ok: false,
        message: "Wallet not found",
      });
    }

    const row = rows[0];

    const sellRate =
      Number(
        row.latest_sell_rate_usd_per_min
      );

    return res.json({
      ok: true,

      wallet: {
        user_id:
          row.user_id,

        currency:
          row.currency,

        balance_cents:
          row.balance_cents,

        updated_at:
          row.updated_at,
      },

      estimated_call_rate:
        Number.isFinite(sellRate) &&
        sellRate > 0
          ? {
              sell_rate_usd_per_min:
                sellRate,

              to_phone_e164:
                row.latest_call_to_phone_e164,

              matched_prefix:
                row.latest_matched_prefix,

              call_session_id:
                row.latest_call_session_id,

              rate_saved_at:
                row.latest_call_created_at,
            }
          : null,
    });
  } catch (e) {
    console.error(
      "wallet/me error:",
      e
    );

    return res.status(500).json({
      ok: false,
      message:
        e.message ||
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
    const userId = Number(req.user.id);
    const limit = Math.min(Number(req.query.limit || 20), 100);

    const q = `
      SELECT id, type, amount_cents, status, balance_after_cents, created_at, meta
      FROM wallet_transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2;
    `;

    const { rows } = await db.query(q, [userId, limit]);

   return res.json({
    ok: true,
    items: rows,
    transactions: rows,
    });

  } catch (e) {
    console.error("wallet/tx error:", e);
    return res.status(500).json({
      ok: false,
      message: e.message,
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
    const phone = req.body.phone_e164;
    const amountCents = Number(req.body.amount_cents);
    const currency = (req.body.currency || "USD").toUpperCase();
    const meta = req.body.meta || {};

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
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
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

    const userResult = await db.query(userQ, [phone]);

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
    const userId = Number(userResult.rows[0].id);

    /// =====================================
    /// STEP 8:
    /// wallet service call
    /// টাকা add হবে
    /// =====================================
    const result = await walletService.creditWallet({
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
        recharged_by_admin: req.user.phone,
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
    console.error("wallet/credit error:", e);

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
    const userId = Number(req.body.user_id || req.user.id);
    const amountCents = Number(req.body.amount_cents);
    const currency = (req.body.currency || "USD").toUpperCase();
    const meta = req.body.meta || {};

    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({
        ok: false,
        message: "Invalid input",
      });
    }

    const result = await walletService.debitWallet({
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
    console.error("wallet/debit error:", e);
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
async function transferBalance(req, res) {

  try {

    /// =====================================
    /// STEP 1:
    /// Login করা sender user
    /// =====================================
    const senderUserId = Number(req.user.id);

/// =====================================
/// STEP 1.1:
/// Transfer cooldown check
/// 30 second wait required
/// =====================================

const now = Date.now();

const lastTransfer =
  transferCooldown[senderUserId];

/// যদি last transfer থাকে
if (lastTransfer) {

  const diffSeconds =
    (now - lastTransfer) / 1000;
console.log(
    "Cooldown Seconds:",
    diffSeconds
  );
  /// 10 second এর কম হলে block
  if (diffSeconds < 30) {

    return res.status(429).json({
      ok: false,

      message:
        `Please wait ${Math.ceil(
          30 - diffSeconds
        )} seconds`,
    });
  }
}


    /// sender phone
    const senderPhone = req.user.phone;

    /// =====================================
    /// STEP 2:
    /// Request body থেকে data নেওয়া
    /// =====================================
    const receiverPhone =
      req.body.phone_e164;

    const amountCents =
      Number(req.body.amount_cents);

    const currency =
      (req.body.currency || "USD")
        .toUpperCase();

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

    /// =====================================
    /// amount invalid হলে
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
    if (!receiverResult.rows.length) {

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
      Number(receiverUser.id);

    /// =====================================
    /// STEP 6:
    /// Self transfer block
    /// =====================================
    if (
      senderUserId === receiverUserId
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

        userId: senderUserId,

        amountCents,

        currency,

        txType: "transfer_sent",

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

        userId: receiverUserId,

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
transferCooldown[senderUserId] =
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