const db = require("../database/db");

const {
  createNotification,
} = require("../notifications/notification.service");

const {
  getFax,
  normalizeFaxStatus,
  verifyStatusToken,
} = require("../services/telnyxFax.service");

const EVENT_STATUSES = {
  "fax.queued": "queued",
  "fax.media.processed": "media_processed",
  "fax.sending.started": "sending",
  "fax.delivered": "delivered",
  "fax.failed": "failed",
};

const STATUS_RANK = {
  queued: 0,
  initiated: 0,
  media_processed: 1,
  receiving: 1,
  originated: 2,
  media_processing: 2,
  sending: 3,
  delivered: 4,
  received: 4,
  failed: 4,
};

function getEventData(event) {
  const data = event?.data || event || {};
  const payload = data.payload || {};
  return {
    eventType: String(data.event_type || "unknown"),
    payload,
    // data.id identifies the event, not the fax.
    faxId: String(payload.fax_id || payload.id || "").trim(),
  };
}

function getLocalFaxId(clientState) {
  if (typeof clientState !== "string") return null;
  const decoded = Buffer.from(clientState, "base64").toString("utf8");
  const match = /^netphone-fax-([1-9]\d*)$/.exec(decoded);
  const id = match ? Number(match[1]) : null;
  return Number.isSafeInteger(id) ? id : null;
}

function matchesFax(fax, providerFax, faxId) {
  if ((fax.direction !== "outbound" && fax.direction !== "inbound") ||
      providerFax.direction !== fax.direction) return false;
  if (String(providerFax.id) !== String(faxId)) return false;
  if (String(providerFax.from || "").trim() !== String(fax.from_number || "").trim() ||
      String(providerFax.to || "").trim() !== String(fax.to_number || "").trim()) return false;
  if (fax.telnyx_fax_id) return String(fax.telnyx_fax_id) === String(faxId);
  return getLocalFaxId(providerFax.client_state) === Number(fax.id);
}

function getPageCount(payload) {
  const value = payload.page_count ?? payload.pages;
  if (value === null || value === undefined || value === "") return null;
  const pages = Number(value);
  return Number.isInteger(pages) && pages >= 0 ? pages : null;
}

async function applyFaxStatus(fax, faxId, newStatus, payload) {
  const previousStatus = normalizeFaxStatus(fax.status);
  if (!(newStatus in STATUS_RANK)) return fax;
  const inboundStatus = new Set(["queued", "initiated", "receiving", "media_processing", "received", "failed"]);
  const outboundStatus = new Set(["queued", "media_processed", "originated", "sending", "delivered", "failed"]);
  if (!(fax.direction === "inbound" ? inboundStatus : outboundStatus).has(newStatus)) return fax;

  // A late or duplicated intermediate event must never undo a final result.
  if ((previousStatus === "delivered" || previousStatus === "received" || previousStatus === "failed") &&
      previousStatus !== newStatus) return fax;
  if ((STATUS_RANK[newStatus] ?? 0) < (STATUS_RANK[previousStatus] ?? 0)) return fax;

  const pages = getPageCount(payload);
  const failureReason = newStatus === "failed"
    ? String(payload.failure_reason || fax.failure_reason || "Fax delivery failed").substring(0, 2000)
    : null;

  if (fax.telnyx_fax_id === faxId && fax.status === newStatus &&
      (pages === null || Number(fax.pages) === pages) &&
      (fax.failure_reason || null) === failureReason) return fax;

  // Compare the status read above. A concurrent update is retried instead
  // of overwriting a newer result. No new table or migration is needed.
  const result = await db.query(
    `UPDATE netphone_faxes
     SET
       telnyx_fax_id = COALESCE(telnyx_fax_id, $1),
       status = $2,
       pages = COALESCE($3, pages),
       failure_reason = $4,
       updated_at = NOW()
     WHERE id = $5
       AND direction = $7
       AND (telnyx_fax_id IS NULL OR telnyx_fax_id = $1)
       AND status = $6
     RETURNING *`,
    [faxId, newStatus, pages, failureReason, fax.id, fax.status, fax.direction]
  );
  const updatedFax = result.rows[0];
  if (!updatedFax) return null;

  if (previousStatus !== newStatus && (newStatus === "delivered" || newStatus === "failed")) {
    try {
      await createNotification({
        userId: updatedFax.user_id,
        faxId: updatedFax.id,
        title: newStatus === "delivered" ? "Fax Delivered" : "Fax Failed",
        message: newStatus === "delivered"
          ? `Your fax to ${updatedFax.to_number} was delivered successfully.`
          : updatedFax.direction === "inbound"
            ? `Your incoming fax from ${updatedFax.from_number} could not be received.`
            : `Your fax to ${updatedFax.to_number} could not be delivered.`,
        notificationType: newStatus === "delivered" ? "fax_delivered" : "fax_failed",
      });
    } catch (error) {
      console.error("Fax Final Notification Error:", error.message);
    }
  }
  return updatedFax;
}

// Read-only Telnyx lookup, followed by an update of this app's existing
// record. This also repairs older records with missed callbacks; it never
// creates an inbound record or changes the existing receiver's media flow.
async function refreshFaxStatus(fax) {
  if ((fax.direction !== "outbound" && fax.direction !== "inbound") ||
      !fax.telnyx_fax_id) return fax;
  const providerFax = await getFax(fax.telnyx_fax_id);
  if (!matchesFax(fax, providerFax, fax.telnyx_fax_id)) {
    throw new Error("Fax status does not match the NetPhone record.");
  }
  const status = normalizeFaxStatus(providerFax.status);
  return applyFaxStatus(fax, fax.telnyx_fax_id, status, providerFax);
}

async function telnyxStatusWebhook(req, res) {
  try {
    const { eventType, payload, faxId } = getEventData(req.body || {});

    // The inbound/IRS receiver keeps its existing routes and behaviour.
    if (payload.direction === "inbound" || eventType === "fax.received" ||
        eventType.startsWith("fax.receiving.") || eventType.startsWith("fax.media.processing.")) {
      return res.status(200).json({ received: true, ignored: true });
    }
    if (!Object.prototype.hasOwnProperty.call(EVENT_STATUSES, eventType) || !faxId) {
      return res.status(200).json({ received: true, ignored: true });
    }

    const callbackId = String(req.query?.fax_id || "");
    const callbackToken = String(req.query?.token || "");
    const hasCallbackToken = callbackId !== "" || callbackToken !== "";
    const authenticated = hasCallbackToken && verifyStatusToken(callbackId, callbackToken);
    if (hasCallbackToken && !authenticated) {
      return res.status(403).json({ received: false, message: "Invalid fax callback" });
    }

    const localId = authenticated ? Number(callbackId) : getLocalFaxId(payload.client_state);
    const safeLocalId = Number.isSafeInteger(localId) && localId > 0 ? localId : null;
    const result = await db.query(
      `SELECT *
       FROM netphone_faxes
       WHERE direction = 'outbound'
         AND (telnyx_fax_id = $1 OR (id = $2 AND telnyx_fax_id IS NULL))
       LIMIT 1`,
      [faxId, safeLocalId]
    );
    const fax = result.rows[0];
    if (!fax) return res.status(200).json({ received: true, ignored: true });
    if (authenticated && Number(fax.id) !== safeLocalId) {
      return res.status(403).json({ received: false, message: "Fax callback mismatch" });
    }

    let status = EVENT_STATUSES[eventType];
    let statusPayload = payload;
    if (authenticated) {
      if ((payload.from && String(payload.from).trim() !== String(fax.from_number).trim()) ||
          (payload.to && String(payload.to).trim() !== String(fax.to_number).trim())) {
        return res.status(403).json({ received: false, message: "Fax callback mismatch" });
      }
    } else {
      // Older callbacks have no per-fax token. Verify through the
      // authenticated Telnyx API; do not trust a public request body.
      const providerFax = await getFax(faxId);
      if (!matchesFax(fax, providerFax, faxId)) {
        return res.status(200).json({ received: true, ignored: true });
      }
      status = normalizeFaxStatus(providerFax.status);
      statusPayload = providerFax;
    }

    const updatedFax = await applyFaxStatus(fax, faxId, status, statusPayload);
    if (!updatedFax) return res.status(503).json({ received: false, retry: true });
    return res.status(200).json({ received: true, updated: true });
  } catch (error) {
    console.error("Telnyx Fax Status Processing Error:", error.code || error.message);
    // Let Telnyx retry a database/network error instead of losing the event.
    return res.status(503).json({ received: false, retry: true });
  }
}

module.exports = {
  telnyxStatusWebhook,
  refreshFaxStatus,
};
