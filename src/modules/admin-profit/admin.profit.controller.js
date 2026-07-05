const service = require("./admin.profit.service");

async function dashboard(req, res, next) {
  try {
    const [summary, today, countryWise, userCountryWise] = await Promise.all([
      service.getProfitSummary(),
      service.getTodayProfit(),
      service.getCountryWiseProfit(),
      service.getUserCountryWiseProfit(),
    ]);

    return res.json({
      ok: true,
      summary,
      today,
      country_wise: countryWise,
      user_country_wise: userCountryWise,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  dashboard,
};