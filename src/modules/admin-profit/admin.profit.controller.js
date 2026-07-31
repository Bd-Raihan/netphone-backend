const service = require("./admin.profit.service");

async function dashboard(req, res, next) {
  try {
    const [
      summary,
      today,
      callDetails,
      callCountrySummary,
      registeredUserSummary,
      registeredUsers,
    ] = await Promise.all([
      service.getProfitSummary(),
      service.getProfitSummary({ todayOnly: true }),
      service.getCallWiseProfitDetails(),
      service.getCallCountrySummary(),
      service.getRegisteredUserSummary(),
      service.getRegisteredUsers(),
    ]);

    return res.json({
      ok: true,
      summary,
      today,
      call_details: callDetails,
      call_country_summary: callCountrySummary,
      registered_user_summary: registeredUserSummary,
      registered_users: registeredUsers,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { dashboard };
