const db = require("../../config/db");
const walletService = require("../wallet/wallet.service");

/// =======================================
/// CREATE PAYMENT
/// =======================================
async function createPayment(req, res) {

  try {
    /// Logged in user
    const userId = Number(req.user.id);

    /// Request body
    const {
      amount_cents,
      payment_method,

    } = req.body;
   
    /// Validation
    if (
      !Number.isFinite(Number(amount_cents))
    ) {
      return res.status(400).json({
        ok: false,
        message: "Invalid amount",
      });
    }

    /// Minimum recharge
    if (Number(amount_cents) < 100) {

      return res.status(400).json({
        ok: false,
        message:
          "Minimum recharge is 0.100 USD",
      });
    }

    /// Maximum recharge
    if (Number(amount_cents) > 500000) {

      return res.status(400).json({
        ok: false,
        message:
          "Maximum recharge is 500 USD",
      });
    }
   
    /// Supported methods
    const allowedMethods = [

      "visa",
      "mastercard",
      "google_pay",
      "apple_pay",
      "crypto",
    ];

    if (
      !allowedMethods.includes(
        payment_method
      )
    ) {
      return res.status(400).json({
        ok: false,
        message:
          "Unsupported payment method",
      });
    }

    /// Save payment transaction
    const insertQ = `

      INSERT INTO payment_transactions (

        user_id,
        payment_method,
        gateway,
        amount_cents,
        currency,
        status,
        transaction_type

      )

      VALUES (
        $1,
        $2,
        $3,
        $4,
        'USD',
        'pending',
        'wallet_recharge'
      )
      RETURNING *
    `;

    const result = await db.query(
      insertQ,
      [
        userId,
        payment_method,
        "sandbox_gateway",
        amount_cents,
      ]
    );

    /// FRAUD CHECK
    /// Too many payment requests

const recentPaymentQ = `

SELECT COUNT(*) AS total
FROM payment_transactions
WHERE user_id = $1
AND created_at >
(
  NOW() - INTERVAL '1 minute'
)

`;

const recentPayment =
  await db.query(
    recentPaymentQ,
    [userId]
  );

if (
  Number(
    recentPayment.rows[0].total
  ) >= 5
) {

  await db.query(
  `
  INSERT INTO fraud_logs (
    user_id,
    event_type,
    details
  )
  VALUES (
    $1,
    $2,
    $3::jsonb
  )
  `,
  [
    userId,
    "payment_rate_limit",
    JSON.stringify({
      payments_last_minute:
        recentPayment.rows[0].total,
    }),
  ]
);
    
    return res.status(429).json({
    ok: false,
    message:
      "Too many payment requests. Please wait.",
  });
}
  
    /// Success response

    return res.json({

      ok: true,

      message:
        "Payment request created",

      payment:
        result.rows[0],

    });

  } catch (e) {

    console.error(
      "payment/create error:",
      e
    );

    return res.status(500).json({

      ok: false,
      message: e.message,

    });
  }
}

/// =======================================
/// PAYMENT WEBHOOK
/// =======================================
async function paymentWebhook(req, res) {
  try {
    
    /// WEBHOOK SECRET VALIDATION
    const webhookSecret =
      req.headers["x-webhook-secret"];

    if (
      webhookSecret !==
      process.env.WEBHOOK_SECRET
    ) {
      return res.status(401).json({
        ok: false,
        message: "Invalid webhook secret",
      });
    }

    /// Webhook data
    const {payment_id, status, gateway_payment_id,} = req.body;

   
    /// FAILED PAYMENT STATUS
    const allowedStatuses = [

    "success",
    "failed",
    "cancelled",
    "expired",
    "pending",

    ];

    if (
        !allowedStatuses.includes(status)
        ) {
            return res.status(400).json({

            ok: false,
            message:
                 "Invalid payment status",

            });
        }

   
        /// FAILED PAYMENT
        if (
            status === "failed" ||
            status === "cancelled" ||
            status === "expired"
            ) {

    console.log("PAYMENT FAILED:", payment_id );
    }


    console.log(
      "PAYMENT WEBHOOK:",
      req.body
    );

   
    /// DUPLICATE GATEWAY CHECK

    if (gateway_payment_id) {

    const duplicateCheck =
    await db.query(
      `
      SELECT id
      FROM payment_transactions
      WHERE gateway_payment_id = $1
      LIMIT 1
      `,
      [gateway_payment_id]
    );

  if (
    duplicateCheck.rows.length
  ) {

    await db.query(
      `
      INSERT INTO fraud_logs (
        user_id,
        event_type,
        details
      )
      VALUES (
        $1,
        $2,
        $3::jsonb
      )
      `,
      [
        null,
        "duplicate_gateway_payment",
        JSON.stringify({
          gateway_payment_id,
        }),
      ]
    );

    return res.status(409).json({

      ok: false,

      message:
        "Duplicate gateway payment detected",

    });
  }
}

    /// Update payment transactions
    const updateQ = `
      UPDATE payment_transactions
      SET
        status = $1,
        gateway_payment_id = $2,
        updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `;
    const result = await db.query(
      updateQ,
      [
        status,
        gateway_payment_id,
        payment_id,
      ]
    );
    /// Payment success
    /// Auto wallet credit
    if (
        status === "success" &&
        !result.rows[0].wallet_credit_done
        ) {
    const payment =
    result.rows[0];

    const creditResult =
        await walletService.creditWallet({

      userId:
        payment.user_id,

      amountCents:
        payment.amount_cents,

      currency:
        payment.currency,

      meta: {
        type: "payment_recharge",
        payment_id: payment.id,
      },
    });

    if (creditResult.ok) {

        await db.query(
      `
        UPDATE payment_transactions
        SET wallet_credit_done = true
         WHERE id = $1
      `,
        [payment.id]
        );
    }
    }
    /// payment না পাওয়া গেলে
    if (!result.rows.length) {

      return res.status(404).json({
        ok: false,
        message: "Payment not found",
      });
    }

    /// Success
    return res.json({

      ok: true,

      message:
        "Payment updated successfully",

      payment:
        result.rows[0],

    });

  } catch (e) {

    console.error(
      "payment webhook error:",
      e
    );

    return res.status(500).json({

      ok: false,
      message: e.message,

    });
  }
}



module.exports = {

  createPayment,
  paymentWebhook,

};