"use strict";
const db = require("../../config/db");
const guard = require("./guard.service");
const crypto = require("crypto");
async function fingerprint(c) {
  const hash = crypto.createHash("sha256");
  for (const table of ["users", "wallets", "wallet_transactions"]) {
    const { rows } = await c.query(`SELECT row_to_json(t)::text AS record FROM ${table} t ORDER BY row_to_json(t)::text`);
    hash.update(table + "\n");
    for (const row of rows) hash.update(row.record + "\n");
  }
  return hash.digest("hex");
}
async function start(actor, confirmation) {
  if (confirmation !== "START_NEW_CALLING_PERIOD")
    throw Object.assign(Error("Confirm the new Calling reporting period"), {statusCode: 422});
  return guard.transaction(async c => {
    await c.query("SET LOCAL lock_timeout = '5s'");
    // Hold writes briefly so verification compares the exact same user/ledger rows.
    await c.query("LOCK TABLE users, wallets, wallet_transactions, call_sessions IN SHARE MODE");
    const {rows: active} = await c.query("SELECT 1 FROM call_sessions WHERE ended_at IS NULL AND status NOT IN ('failed','charged','ended','completed','canceled','cancelled') LIMIT 1");
    if (active.length) throw Object.assign(Error("Finish active calls before starting a new reporting period"), {statusCode: 409});
    const previous = (await c.query("SELECT reporting_started_at FROM voice_guard_settings WHERE id=1 FOR UPDATE")).rows[0];
    const before = await fingerprint(c);
    const row = (await c.query("UPDATE voice_guard_settings SET reporting_started_at=clock_timestamp() WHERE id=1 RETURNING reporting_started_at")).rows[0];
    if (before !== await fingerprint(c)) throw Error("Account or wallet verification failed; reset rolled back");
    await guard.audit(c, actor, "calling_reporting_period_started", {previous: previous.reporting_started_at, started_at: row.reporting_started_at, account_ledger_sha256: before, retained_financial_records: true});
    return {...row, accounts_and_wallets_unchanged: true};
  });
}
module.exports = {start};
