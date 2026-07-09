const service = require("./rates.service");

async function listRates(req, res, next) {
  try {
    const rates = await service.getPublicRates();

    return res.json({
      ok: true,
      items: rates,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { listRates };