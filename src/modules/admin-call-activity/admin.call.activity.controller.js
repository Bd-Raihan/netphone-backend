"use strict";

const service = require(
  "./admin.call.activity.service"
);

// ============================================================
// 🇧🇩 ADMIN CALL ACTIVITY / CDR CONTROLLER
//
// শুধুমাত্র Admin investigation report API পরিচালনা করে।
// Calling / Billing / Wallet logic এখানে নেই।
// ============================================================

function buildFilters(query = {}) {
  return {
    search:
      query.search,

    registeredNumber:
      query.registered_number,

    destinationNumber:
      query.destination_number,

    originCountry:
      query.origin_country,

    destinationCountry:
      query.destination_country,

    status:
      query.status,

    provider:
      query.provider,

    fromDate:
      query.from_date,

    toDate:
      query.to_date,

    limit:
      query.limit,

    offset:
      query.offset,
  };
}

/**
 * GET /api/admin/call-activity
 */
async function list(
  req,
  res,
  next
) {
  try {
    const filters =
      buildFilters(
        req.query || {}
      );

    const [
      summary,
      activity,
    ] =
      await Promise.all([
        service
          .getCallActivitySummary(
            filters
          ),

        service
          .getCallActivityList(
            filters
          ),
      ]);

    return res
      .status(200)
      .json({
        ok: true,

        summary,

        pagination: {
          total:
            activity.total,

          limit:
            activity.limit,

          offset:
            activity.offset,
        },

        calls:
          activity.rows,
      });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/admin/call-activity/:id
 */
async function details(
  req,
  res,
  next
) {
  try {
    const call =
      await service
        .getCallActivityById(
          req.params.id
        );

    if (!call) {
      return res
        .status(404)
        .json({
          ok: false,
          message:
            "Call activity not found",
        });
    }

    return res
      .status(200)
      .json({
        ok: true,
        call,
      });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list,
  details,
};