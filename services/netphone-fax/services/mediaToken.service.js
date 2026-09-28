const crypto = require("crypto");
const db = require("../database/db");

const TOKEN_LIFETIME_MINUTES = 30;

function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

async function createMediaToken(faxId) {
  if (!faxId) {
    throw new Error("faxId is required");
  }

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);

  const expiresAt = new Date(
    Date.now() + TOKEN_LIFETIME_MINUTES * 60 * 1000
  );

  await db.query(
    `INSERT INTO netphone_fax_media_tokens
     (
       fax_id,
       token_hash,
       expires_at
     )
     VALUES ($1, $2, $3)`,
    [
      faxId,
      tokenHash,
      expiresAt,
    ]
  );

  return {
    token,
    expiresAt,
  };
}

async function validateMediaToken(token) {
  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);

  const result = await db.query(
    `SELECT
       mt.id AS media_token_id,
       mt.fax_id,
       mt.expires_at,
       f.user_id,
       f.file_name,
       f.file_url,
       f.direction,
       f.status
     FROM netphone_fax_media_tokens mt
     INNER JOIN netphone_faxes f
       ON f.id = mt.fax_id
     WHERE mt.token_hash = $1
       AND mt.expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );

  const record = result.rows[0];

  if (!record) {
    return null;
  }

  // Audit only.
  // Do not invalidate immediately because Telnyx
  // may need to fetch the document more than once.
  await db.query(
    `UPDATE netphone_fax_media_tokens
     SET used_at = COALESCE(used_at, NOW())
     WHERE id = $1`,
    [record.media_token_id]
  );

  return record;
}

async function revokeMediaTokens(faxId) {
  await db.query(
    `DELETE FROM netphone_fax_media_tokens
     WHERE fax_id = $1`,
    [faxId]
  );
}

module.exports = {
  createMediaToken,
  validateMediaToken,
  revokeMediaTokens,
};