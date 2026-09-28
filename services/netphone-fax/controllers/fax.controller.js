const db = require("../database/db");

async function createFax(req, res) {
  try {
    const {
      user_id,
      sender_name,
      from_number,
      to_number,
      user_email,
      country_code,
      file_name,
      file_url,
    } = req.body;

    if (!user_id || !to_number || !file_url) {
      return res.status(400).json({
        success: false,
        message: "user_id, to_number and file_url are required",
      });
    }

    const result = await db.query(
      `INSERT INTO netphone_faxes
       (
         user_id,
         sender_name,
         direction,
         from_number,
         to_number,
         status,
         file_name,
         file_url,
         user_email,
         country_code
       )
       VALUES ($1,$2,'outbound',$3,$4,'queued',$5,$6,$7,$8)
       RETURNING *`,
      [
        user_id,
        sender_name || null,
        from_number || null,
        to_number,
        file_name || null,
        file_url,
        user_email || null,
        country_code || null,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Fax record created",
      fax: result.rows[0],
    });
  } catch (error) {
    console.error("Create Fax Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to create fax",
    });
  }
}

module.exports = {
  createFax,
};