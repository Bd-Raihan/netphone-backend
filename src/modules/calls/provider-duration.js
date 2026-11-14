"use strict";

function iso(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function eventTimes(type, event = {}, payload = {}) {
  return {
    answeredAt: type === "call.answered" ? iso(event.occurred_at) : null,
    endedAt: type === "call.hangup" ? iso(payload.end_time) || iso(event.occurred_at) : null,
  };
}

function connectedSeconds({rawPayload = {}, answeredAt, endedAt}) {
  // billable_seconds is a rounded billing quantity, not talk duration.
  for (const key of ["CallDuration", "Duration", "duration_sec", "duration_secs", "duration_seconds"]) {
    const candidate = rawPayload[key];
    if (candidate === null || candidate === undefined || String(candidate).trim() === "") continue;
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return Math.floor(value);
  }
  const start = iso(answeredAt), end = iso(rawPayload.end_time) || iso(endedAt);
  if (!start || !end) return 0;
  return Math.max(0, Math.ceil((Date.parse(end) - Date.parse(start)) / 1000));
}

function statusTiming(call, now = new Date()) {
  const answeredAt = iso(call.answered_at), endedAt = iso(call.ended_at);
  const finalized = !!endedAt;
  const stored = call.duration_sec;
  const seconds = finalized && stored != null && Number.isFinite(Number(stored))
    ? Math.max(0, Math.floor(Number(stored)))
    : connectedSeconds({answeredAt, endedAt: finalized ? endedAt : now});
  return {server_time: iso(now), answered_at: answeredAt, ended_at: endedAt,
    elapsed_seconds: answeredAt ? seconds : 0, finalized};
}
module.exports = {connectedSeconds, eventTimes, statusTiming};
