const ALLOWED_PRICING_MODES =
  new Set([
    "auto_markup",
    "manual_rate",
  ]);

function normalizePrefix(value) {
  const normalized =
    String(value ?? "")
      .replace(/\D/g, "");

  if (!/^[0-9]{1,20}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeCountryCode(value) {
  const normalized =
    String(value ?? "")
      .trim()
      .toUpperCase()
      .slice(0, 8);

  return normalized || null;
}

function parseNonNegativeNumber(value) {
  const parsed = Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed < 0
  ) {
    return null;
  }

  return parsed;
}

function parsePositiveNumber(value) {
  const parsed = Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed <= 0
  ) {
    return null;
  }

  return parsed;
}

function parseOptionalBoolean(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  if (value === true || value === false) {
    return value;
  }

  const normalized =
    String(value)
      .trim()
      .toLowerCase();

  if (
    ["true", "1", "yes", "on"]
      .includes(normalized)
  ) {
    return true;
  }

  if (
    ["false", "0", "no", "off"]
      .includes(normalized)
  ) {
    return false;
  }

  return null;
}

function validatePricingUpdate(input) {
  const body =
    input &&
    typeof input === "object"
      ? input
      : {};

  const pricingMode =
    String(
      body.pricing_mode ?? ""
    )
      .trim()
      .toLowerCase();

  if (
    !ALLOWED_PRICING_MODES
      .has(pricingMode)
  ) {
    return {
      ok: false,
      message:
        "pricing_mode must be auto_markup or manual_rate",
    };
  }

  const countryCode =
    normalizeCountryCode(
      body.country_code
    );

  const note =
    body.note === undefined ||
    body.note === null
      ? null
      : String(body.note)
          .trim()
          .slice(0, 500);

  const isActive =
    parseOptionalBoolean(
      body.is_active
    );

  if (pricingMode === "auto_markup") {
    const markupPercent =
      parseNonNegativeNumber(
        body.markup_percent
      );

    if (markupPercent === null) {
      return {
        ok: false,
        message:
          "A valid non-negative markup_percent is required",
      };
    }

    if (markupPercent > 1000) {
      return {
        ok: false,
        message:
          "markup_percent cannot exceed 1000",
      };
    }

    return {
      ok: true,

      value: {
        pricing_mode:
          pricingMode,

        country_code:
          countryCode,

        markup_percent:
          markupPercent,

        manual_sell_rate_usd_per_min:
          null,

        note,
        is_active: isActive,
      },
    };
  }

  const manualSellRate =
    parsePositiveNumber(
      body.manual_sell_rate_usd_per_min
    );

  if (manualSellRate === null) {
    return {
      ok: false,
      message:
        "A valid positive manual_sell_rate_usd_per_min is required",
    };
  }

  return {
    ok: true,

    value: {
      pricing_mode:
        pricingMode,

      country_code:
        countryCode,

      markup_percent:
        null,

      manual_sell_rate_usd_per_min:
        manualSellRate,

      note,
      is_active: isActive,
    },
  };
}

module.exports = {
  normalizePrefix,
  normalizeCountryCode,
  validatePricingUpdate,
};