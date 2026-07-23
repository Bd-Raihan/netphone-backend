/**
 * telnyx-webrtc.service.js
 * --------------------------------------------------
 * Production Telnyx WebRTC authentication service.
 *
 * Responsibilities:
 * 1. Create one Telnyx Telephony Credential per user
 * 2. Store only the provider credential ID
 * 3. Generate short-lived WebRTC JWT access tokens
 * 4. Never expose the Telnyx API key to Flutter
 */

const db = require("../../config/db");

const {
  telnyxRequest,
} = require("./telnyx.service");

const PROVIDER_CODE = "telnyx";
const CREDENTIAL_LIFETIME_DAYS = 365;
const RENEW_BEFORE_DAYS = 7;

/**
 * Credential-based SIP Connection ID.
 *
 * This is NOT the Voice API Application ID.
 */
function getSipConnectionId() {
  const connectionId = String(
    process.env.TELNYX_SIP_CONNECTION_ID || ""
  ).trim();

  if (!connectionId) {
    throw new Error(
      "TELNYX_SIP_CONNECTION_ID is missing"
    );
  }

  return connectionId;
}

function addDays(date, days) {
  const result = new Date(date);

  result.setUTCDate(
    result.getUTCDate() + Number(days || 0)
  );

  return result;
}

function isCredentialReusable(row) {
  if (!row) {
    return false;
  }

  if (row.status !== "active") {
    return false;
  }

  if (!row.provider_credential_id) {
    return false;
  }

  if (!row.credential_expires_at) {
    return true;
  }

  const renewThreshold = addDays(
    new Date(),
    RENEW_BEFORE_DAYS
  );

  return (
    new Date(row.credential_expires_at) >
    renewThreshold
  );
}

/**
 * Create a Telnyx Telephony Credential.
 *
 * Telnyx returns:
 * - data.id
 * - data.sip_username
 * - data.sip_password
 *
 * We intentionally store only data.id.
 */
async function createRemoteCredential({
  userId,
}) {
  const connectionId =
    getSipConnectionId();

  const expiresAt = addDays(
    new Date(),
    CREDENTIAL_LIFETIME_DAYS
  );

  const result = await telnyxRequest({
    path: "/telephony_credentials",
    method: "POST",
    body: {
      connection_id: connectionId,

      name:
        `netphone-user-${userId}`,

      tag:
        "netphone-webrtc",

      expires_at:
        expiresAt.toISOString(),
    },
  });

  const credential =
    result?.data || null;

  const credentialId =
    String(
      credential?.id || ""
    ).trim();

  if (!credentialId) {
    const error = new Error(
      "Telnyx did not return a telephony credential ID"
    );

    error.telnyxResponse = result;

    throw error;
  }

  return {
    credentialId,
    connectionId,
    expiresAt:
      credential?.expires_at ||
      expiresAt.toISOString(),
  };
}

/**
 * Return an active per-user credential.
 *
 * PostgreSQL advisory lock prevents two simultaneous
 * requests from creating duplicate Telnyx credentials
 * for the same NetPhone user.
 */
async function ensureUserCredential({
  userId,
}) {
  const normalizedUserId =
    Number(userId);

  if (
    !Number.isInteger(normalizedUserId) ||
    normalizedUserId <= 0
  ) {
    throw new Error(
      "Valid userId is required"
    );
  }

  const client =
    await db.pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
        SELECT pg_advisory_xact_lock(
          $1::bigint
        )
      `,
      [
        700000000000 +
          normalizedUserId,
      ]
    );

    const existingResult =
      await client.query(
        `
          SELECT *
          FROM voice_user_credentials
          WHERE user_id = $1::bigint
            AND provider_code = $2::text
          LIMIT 1
          FOR UPDATE
        `,
        [
          normalizedUserId,
          PROVIDER_CODE,
        ]
      );

    const existing =
      existingResult.rows[0] || null;

    if (isCredentialReusable(existing)) {
      await client.query("COMMIT");

      return {
        id: existing.id,

        userId:
          normalizedUserId,

        credentialId:
          existing.provider_credential_id,

        connectionId:
          existing.connection_id,

        credentialExpiresAt:
          existing.credential_expires_at,

        reused: true,
      };
    }

    const remoteCredential =
      await createRemoteCredential({
        userId: normalizedUserId,
      });

    const savedResult =
      await client.query(
        `
          INSERT INTO voice_user_credentials
          (
            user_id,
            provider_code,
            provider_credential_id,
            connection_id,
            status,
            credential_expires_at,
            metadata
          )
          VALUES
          (
            $1::bigint,
            $2::text,
            $3::text,
            $4::text,
            'active',
            $5::timestamptz,
            $6::jsonb
          )

          ON CONFLICT
            (user_id, provider_code)

          DO UPDATE SET
            provider_credential_id =
              EXCLUDED.provider_credential_id,

            connection_id =
              EXCLUDED.connection_id,

            status =
              'active',

            credential_expires_at =
              EXCLUDED.credential_expires_at,

            metadata =
              voice_user_credentials.metadata ||
              EXCLUDED.metadata,

            updated_at =
              NOW()

          RETURNING *
        `,
        [
          normalizedUserId,
          PROVIDER_CODE,
          remoteCredential.credentialId,
          remoteCredential.connectionId,
          remoteCredential.expiresAt,

          JSON.stringify({
            managed_by:
              "netphone_backend",

            credential_type:
              "telnyx_telephony_credential",
          }),
        ]
      );

    await client.query("COMMIT");

    const saved =
      savedResult.rows[0];

    return {
      id: saved.id,

      userId:
        normalizedUserId,

      credentialId:
        saved.provider_credential_id,

      connectionId:
        saved.connection_id,

      credentialExpiresAt:
        saved.credential_expires_at,

      reused: false,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve original error.
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Generate a short-lived Telnyx JWT for Flutter SDK.
 */
async function issueWebrtcToken({
  userId,
}) {
  const credential =
    await ensureUserCredential({
      userId,
    });

  const result = await telnyxRequest({
    path:
      `/telephony_credentials/${encodeURIComponent(
        credential.credentialId
      )}/token`,

    method: "POST",
  });

  /*
   * Telnyx token endpoint may return the JWT as a
   * JSON string instead of an object.
   */
  const tokenCandidate =
  typeof result === "string"
    ? result
    : (
        result?.token ||
        result?.access_token ||
        result?.data?.token ||
        result?.data?.access_token ||
        (
          typeof result?.data === "string"
            ? result.data
            : ""
        ) ||
        result?.message ||
        ""
      );

const normalizedToken = String(
  tokenCandidate || ""
)
  .trim()
  .replace(/^"(.*)"$/s, "$1");


  if (
  !normalizedToken ||
  !normalizedToken.startsWith("eyJ")
) {
  const error = new Error(
    "Telnyx did not return a valid WebRTC token"
  );

  error.telnyxResponse = result;

  throw error;
}

  await db.query(
    `
      UPDATE voice_user_credentials
      SET
        last_token_issued_at = NOW(),
        updated_at = NOW()
      WHERE user_id = $1::bigint
        AND provider_code = $2::text
    `,
    [
      Number(userId),
      PROVIDER_CODE,
    ]
  );

  return {
    token: normalizedToken,

    credentialId:
      credential.credentialId,

    connectionId:
      credential.connectionId,

    credentialExpiresAt:
      credential.credentialExpiresAt,
  };
}

module.exports = {
  ensureUserCredential,
  issueWebrtcToken,
};