/**
 * countries.controller.js
 * কাজ:
 * - সব দেশ দেখানো
 * - শুধু active দেশ দেখানো
 * - admin দিয়ে country on/off করা
 * - country rate দেখানো / আপডেট করা
 */

const db = require("../../config/db");

// ✅ Helper: country code normalize (bd -> BD)
function normalizeCode(code) {
  return String(code || "").trim().toUpperCase();
}

/**
 * GET /countries
 * কাজ: সব দেশের তালিকা (admin/public both দেখতে পারবে)
 */
async function listCountries(req, res) {
  try {
    const result = await db.query(
      `SELECT country_code, country_name, is_active, risk_level
       FROM countries
       ORDER BY country_code`
    );

    return res.status(200).json({ ok: true, data: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * GET /countries/active
 * কাজ: শুধু যেগুলো active (user call করতে পারবে)
 */
async function listActiveCountries(req, res) {
  try {
    const result = await db.query(
      `SELECT country_code, country_name, is_active, risk_level
       FROM countries
       WHERE is_active = TRUE
       ORDER BY country_code`
    );

    return res.status(200).json({ ok: true, data: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * PATCH /countries/:code/toggle
 * body: { is_active: true/false }
 * কাজ: admin দেশ অন/অফ করতে পারবে
 */
async function toggleCountry(req, res) {
  try {
    const code = normalizeCode(req.params.code);
    const { is_active } = req.body;

    // ✅ basic validation
    if (!code || code.length !== 2) {
      return res.status(400).json({ ok: false, message: "Invalid country code" });
    }

    if (typeof is_active !== "boolean") {
      return res.status(400).json({
        ok: false,
        message: "is_active must be boolean (true/false)",
      });
    }

    const result = await db.query(
      `UPDATE countries
       SET is_active = $1
       WHERE country_code = $2
       RETURNING country_code, country_name, is_active, risk_level`,
      [is_active, code]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, message: "Country not found" });
    }

    return res.status(200).json({
      ok: true,
      message: "Country updated",
      data: result.rows[0],
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * GET /countries/:code/rate
 * কাজ: নির্দিষ্ট দেশের রেট দেখানো (sell rate + cost)
 */
async function getCountryRate(req, res) {
  try {
    const code = normalizeCode(req.params.code);

    if (!code || code.length !== 2) {
      return res.status(400).json({ ok: false, message: "Invalid country code" });
    }

    const result = await db.query(
      `SELECT 
          c.country_code,
          c.country_name,
          c.is_active AS country_active,
          r.telnyx_cost_per_min,
          r.sell_rate_per_min,
          r.margin_per_min,
          r.is_active AS rate_active
       FROM countries c
       LEFT JOIN rates r ON r.country_code = c.country_code
       WHERE c.country_code = $1`,
      [code]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, message: "Country not found" });
    }

    return res.status(200).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * PATCH /countries/:code/rate
 * body: { sell_rate_per_min, telnyx_cost_per_min, margin_per_min, is_active }
 * কাজ: admin দেশভিত্তিক রেট আপডেট করবে
 */
async function updateCountryRate(req, res) {
  try {
    const code = normalizeCode(req.params.code);

    if (!code || code.length !== 2) {
      return res.status(400).json({ ok: false, message: "Invalid country code" });
    }

    const {
      sell_rate_per_min,
      telnyx_cost_per_min,
      margin_per_min,
      is_active,
    } = req.body;

    // ✅ numeric validation (যদি value আসে)
    function isNum(v) {
      return typeof v === "number" && Number.isFinite(v);
    }

    if (
      (sell_rate_per_min !== undefined && !isNum(sell_rate_per_min)) ||
      (telnyx_cost_per_min !== undefined && !isNum(telnyx_cost_per_min)) ||
      (margin_per_min !== undefined && !isNum(margin_per_min)) ||
      (is_active !== undefined && typeof is_active !== "boolean")
    ) {
      return res.status(400).json({
        ok: false,
        message:
          "Invalid body. Numbers must be number type, is_active must be boolean.",
      });
    }

    // ✅ আগে row আছে কিনা দেখবো (rate row)
    const existing = await db.query(
      `SELECT country_code FROM rates WHERE country_code = $1`,
      [code]
    );

    if (existing.rowCount === 0) {
      return res.status(404).json({
        ok: false,
        message: "Rate row not found for this country (seed first).",
      });
    }

    // ✅ dynamic update (যে field পাঠাবে শুধু সেটাই update হবে)
    const fields = [];
    const values = [];
    let idx = 1;

    if (sell_rate_per_min !== undefined) {
      fields.push(`sell_rate_per_min = $${idx++}`);
      values.push(sell_rate_per_min);
    }
    if (telnyx_cost_per_min !== undefined) {
      fields.push(`telnyx_cost_per_min = $${idx++}`);
      values.push(telnyx_cost_per_min);
    }
    if (margin_per_min !== undefined) {
      fields.push(`margin_per_min = $${idx++}`);
      values.push(margin_per_min);
    }
    if (is_active !== undefined) {
      fields.push(`is_active = $${idx++}`);
      values.push(is_active);
    }

    if (fields.length === 0) {
      return res.status(400).json({
        ok: false,
        message: "Nothing to update. Send at least one field.",
      });
    }

    values.push(code); // last param for WHERE

    const query = `
      UPDATE rates
      SET ${fields.join(", ")}
      WHERE country_code = $${idx}
      RETURNING country_code, telnyx_cost_per_min, sell_rate_per_min, margin_per_min, is_active
    `;

    const updated = await db.query(query, values);

    return res.status(200).json({
      ok: true,
      message: "Rate updated",
      data: updated.rows[0],
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = {
  listCountries,
  listActiveCountries,
  toggleCountry,
  getCountryRate,
  updateCountryRate,
};
