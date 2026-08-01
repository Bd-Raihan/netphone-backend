const service =
  require(
    "./admin-country-pricing.service"
  );

const {
  normalizePrefix,
  validatePricingUpdate,
} =
  require(
    "./admin-country-pricing.validation"
  );

async function list(req, res) {
  try {
    const items =
      await service.listCountryPricing({
        search:
          req.query.search || "",
      });

    return res.json({
      ok: true,
      data: {
        total: items.length,
        items,
      },
    });
  } catch (error) {
    console.error(
      "admin country pricing list error:",
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        "Unable to load country pricing",
    });
  }
}

async function getOne(req, res) {
  try {
    const prefix =
      normalizePrefix(
        req.params.prefix
      );

    if (!prefix) {
      return res.status(400).json({
        ok: false,
        message:
          "A valid country prefix is required",
      });
    }

    const item =
      await service
        .getCountryPricingByPrefix(
          prefix
        );

    if (!item) {
      return res.status(404).json({
        ok: false,
        message:
          "Country pricing route was not found",
      });
    }

    return res.json({
      ok: true,
      data: item,
    });
  } catch (error) {
    console.error(
      "admin country pricing details error:",
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        "Unable to load country pricing details",
    });
  }
}

async function update(req, res) {
  try {
    const prefix =
      normalizePrefix(
        req.params.prefix
      );

    if (!prefix) {
      return res.status(400).json({
        ok: false,
        message:
          "A valid country prefix is required",
      });
    }

    const validation =
      validatePricingUpdate(
        req.body
      );

    if (!validation.ok) {
      return res.status(400).json({
        ok: false,
        message:
          validation.message,
      });
    }

    const adminUserId =
      Number(req.user?.id);

    if (
      !Number.isInteger(adminUserId) ||
      adminUserId <= 0
    ) {
      return res.status(401).json({
        ok: false,
        message:
          "Admin authentication is required",
      });
    }

    const result =
      await service
        .updateCountryPricing({
          prefix,
          adminUserId,
          payload:
            validation.value,
        });

    if (!result.ok) {
      if (
        result.reason ===
        "country_route_not_found"
      ) {
        return res.status(404).json({
          ok: false,
          code: result.reason,
          message:
            "Country route was not found",
        });
      }

      if (
        result.reason ===
        "provider_cost_not_available"
      ) {
        return res.status(409).json({
          ok: false,
          code: result.reason,
          message:
            "No active provider cost is available for this country",
        });
      }

      if (
        result.reason ===
        "manual_rate_not_above_provider_cost"
      ) {
        return res.status(400).json({
          ok: false,
          code: result.reason,

          message:
            "Manual sell rate must be greater than the highest provider cost",

          provider_cost_usd_per_min:
            result
              .provider_cost_usd_per_min,

          minimum_allowed_rate:
            result
              .minimum_allowed_rate,
        });
      }

      return res.status(400).json({
        ok: false,
        code: result.reason,
        message:
          "Unable to update country pricing",
      });
    }

    return res.json({
      ok: true,
      message:
        "Country pricing updated successfully",
      data: result.data,
    });
  } catch (error) {
    console.error(
      "admin country pricing update error:",
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        "Unable to update country pricing",
    });
  }
}

async function disableOverride(
  req,
  res
) {
  try {
    const prefix =
      normalizePrefix(
        req.params.prefix
      );

    if (!prefix) {
      return res.status(400).json({
        ok: false,
        message:
          "A valid country prefix is required",
      });
    }

    const adminUserId =
      Number(req.user?.id);

    if (
      !Number.isInteger(adminUserId) ||
      adminUserId <= 0
    ) {
      return res.status(401).json({
        ok: false,
        message:
          "Admin authentication is required",
      });
    }

    const result =
      await service
        .disableManualOverride({
          prefix,
          adminUserId,
        });

    if (!result.ok) {
      return res.status(404).json({
        ok: false,
        code: result.reason,
        message:
          "Manual pricing record was not found",
      });
    }

    return res.json({
      ok: true,
      message:
        "Manual override disabled successfully",
      data: result.data,
    });
  } catch (error) {
    console.error(
      "disable country pricing override error:",
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        "Unable to disable manual override",
    });
  }
}

module.exports = {
  list,
  getOne,
  update,
  disableOverride,
};