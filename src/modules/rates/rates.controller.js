const service = require("./rates.service");

async function listRates(req, res, next) {
  try {
    const rates = req.query.phone ? [await service.getPublicRateByPhone(String(req.query.phone))].filter(Boolean) : await service.getPublicRates();

    res.set("Cache-Control", "no-store");
    return res.json({
      ok: true,
      items: rates,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { listRates };