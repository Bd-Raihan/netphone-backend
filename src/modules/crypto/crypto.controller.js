const db =
  require("../../config/db");


/// ===================================
/// CREATE CRYPTO PAYMENT
/// ===================================
async function createCryptoPayment(
  req,
  res
) {

  return res.json({

    ok: true,

    message:
      "Crypto payment endpoint ready",

  });
}


/// ===================================
/// CRYPTO WEBHOOK
/// ===================================
async function cryptoWebhook(
  req,
  res
) {

  return res.json({

    ok: true,

    message:
      "Crypto webhook ready",

  });
}

module.exports = {

  createCryptoPayment,
  cryptoWebhook,

};