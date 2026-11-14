"use strict";
const db = require("../../config/db"),
  guard = require("./guard.service"),
  m = require("./money-routes"),
  reports = require("./report-client");
let promise = null,
  timer = null,
  watchTimer = null,
  watchBusy = false;
let fastTimer = null, localTimer = null, localBusy = false;
const connections = () => {
  const extra = String(process.env.TELNYX_CALLING_REPORT_CONNECTION_IDS || '')
    .split(',').map(x => x.trim()).filter(Boolean);
  if (extra.some(id => !/^\d{10,25}$/.test(id))) {
    throw Error('Calling report connection IDs must be explicit numeric voice connection IDs');
  }
  return new Set([
    process.env.TELNYX_SIP_CONNECTION_ID, process.env.TELNYX_CONNECTION_ID, ...extra,
  ].filter(Boolean).map(String));
};
async function store(records, c) {
  let accepted = 0;
  for (const r of records) {
    const old = (
      await c.query(
        "SELECT * FROM voice_guard_usage WHERE kind=$1 AND record_key=$2 FOR UPDATE",
        [r.kind, r.key],
      )
    ).rows[0];
    if (
      old &&
      (String(old.session_uuid) !== r.session ||
        old.connection_id !== r.connection ||
        old.from_number !== r.from ||
        old.to_number !== r.to ||
        old.direction !== r.direction)
    )
      throw Error("Provider CDR identity changed; review required");
    if (
      old &&
      (String(old.cost_microusd) !== r.cost ||
        String(old.rate_microusd) !== String(r.rate))
    )
      await guard.audit(c, null, "calling_provider_cost_corrected", {
        kind: r.kind,
        key: r.key,
        old_cost: String(old.cost_microusd),
        new_cost: r.cost,
      });
    await c.query(
      `INSERT INTO voice_guard_usage(kind,record_key,session_uuid,leg_id,connection_id,from_number,to_number,cost_microusd,billed_seconds,rate_microusd,direction)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(kind,record_key) DO UPDATE SET cost_microusd=EXCLUDED.cost_microusd,
  billed_seconds=EXCLUDED.billed_seconds,rate_microusd=EXCLUDED.rate_microusd,updated_at=NOW()`,
      [
        r.kind,
        r.key,
        r.session,
        r.leg,
        r.connection,
        r.from,
        r.to,
        r.cost,
        r.seconds,
        r.rate,
        r.direction,
      ],
    );
    accepted++;
  }
  return accepted;
}
function costResult(usage, wallet) {
  const cost = usage.reduce((n, r) => n + BigInt(r.cost_microusd), 0n);
  const received = BigInt(wallet || 0);
  return {
    cost,
    wallet: received,
    profit: received - cost,
    complete:
      usage.some((r) => r.kind === "sip-trunking") &&
      usage.some((r) => r.kind === "webrtc"),
  };
}
async function reconcile() {
  const calls = (
    await db.query(`SELECT s.*,COALESCE(s.meta->'calling_rate_guard'->>'country_code',r.country_code,'') AS guard_country
 FROM call_sessions s LEFT JOIN voice_routes r ON r.id=s.route_id WHERE s.provider='telnyx' AND s.ended_at IS NOT NULL
 AND s.ended_at<=NOW() AND s.ended_at>NOW()-INTERVAL '7 days' AND EXISTS(SELECT 1 FROM voice_guard_usage u WHERE
 u.session_uuid::text=NULLIF(s.meta->>'telnyx_call_session_id','') OR u.leg_id=NULLIF(s.meta->>'telnyx_call_leg_id',''))
 ORDER BY s.ended_at DESC LIMIT 1000`)
  ).rows;
  for (const call of calls) {
    await guard.transaction(async (c) => {
      // Serialize with another monitor process and read the authoritative wallet ledger, not a UI rate.
      await c.query("SELECT id FROM call_sessions WHERE id=$1 FOR UPDATE", [
        call.id,
      ]);
      const usage = (
        await c.query(
          `SELECT * FROM voice_guard_usage WHERE
  (session_uuid::text=$1 OR leg_id=$2) AND to_number=$3 AND from_number=$4`,
          [
            call.meta?.telnyx_call_session_id || null,
            call.meta?.telnyx_call_leg_id || null,
            m.digits(call.to_phone_e164),
            m.digits(
              call.meta?.provider_phone_number ||
                process.env.TELNYX_PHONE_NUMBER,
            ),
          ],
        )
      ).rows;
      if (!usage.some((x) => x.kind === "sip-trunking")) return;
      const tx = (
        await c.query(
          `SELECT COALESCE(SUM(CASE WHEN type='call_charge' THEN amount_microusd ELSE -amount_microusd END),0)::text AS net
  FROM wallet_transactions WHERE user_id=$1 AND status='posted' AND type IN ('call_charge','call_refund','refund')
  AND (idempotency_key=$2 OR meta->>'session_id'=$3)`,
          [call.user_id, "call_charge:" + call.id, String(call.id)],
        )
      ).rows[0];
      const result = costResult(usage, tx.net),
        prefix = String(
          call.meta?.calling_rate_guard?.prefix ||
            call.meta?.matched_prefix ||
            "",
        ),
        country = call.guard_country;
      const old = (
        await c.query(
          "SELECT * FROM voice_guard_actuals WHERE session_id=$1 FOR UPDATE",
          [call.id],
        )
      ).rows[0];
      const status = result.complete ? "sip_and_webrtc" : "partial";
      await c.query(
        `INSERT INTO voice_guard_actuals(session_id,country_code,prefix,provider_microusd,wallet_microusd,profit_microusd,cost_status)
  VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(session_id) DO UPDATE SET provider_microusd=EXCLUDED.provider_microusd,
  wallet_microusd=EXCLUDED.wallet_microusd,profit_microusd=EXCLUDED.profit_microusd,cost_status=EXCLUDED.cost_status,updated_at=NOW()`,
        [
          call.id,
          country,
          prefix,
          result.cost.toString(),
          result.wallet.toString(),
          result.profit.toString(),
          status,
        ],
      );
      const changed =
        !old ||
        String(old.provider_microusd) !== result.cost.toString() ||
        String(old.wallet_microusd) !== result.wallet.toString() ||
        old.cost_status !== status;
      if (changed && result.profit < 0n)
        await guard.alert(
          "actual:" + call.id,
          country,
          prefix,
          "loss",
          `Calling loss: ${country || "unidentified country"}. Update this rate before more calls.`,
          {
            session_id: call.id,
            provider_usd: m.usd(result.cost),
            wallet_usd: m.usd(result.wallet),
            loss_usd: m.usd(-result.profit),
            cost_status: status,
            minimum_known_loss: !result.complete,
          },
          c,
        );
      if (changed && !result.complete)
        await guard.alert(
          "partial:" + call.id,
          country,
          prefix,
          "warning",
          "Full cost is not verified: matching WebRTC usage is missing.",
          { session_id: call.id, known_cost_usd: m.usd(result.cost) },
          c,
        );
      if (result.complete)
        await c.query(
          "UPDATE voice_guard_alerts SET active=FALSE,resolved_at=NOW() WHERE alert_key=$1 AND severity='warning'",
          ["partial:" + call.id],
        );
      const config = await guard.settings(c);
      if (config.deck_version) {
        try {
          const current = await guard.selectRoute(
            call.to_phone_e164,
            config,
            c,
          );
          const effectivePolicy = await guard.policy(call.to_phone_e164, country, c);
          const targetMarkup = effectivePolicy.markup_percent ?? config.default_markup;
          const observedSip = usage.filter(x => x.kind === 'sip-trunking' && x.direction === 'outbound' && x.rate_microusd != null)
            .reduce((v, x) => BigInt(x.rate_microusd) > v ? BigInt(x.rate_microusd) : v, BigInt(current.rate));
          const observedWeb = usage.filter(x => x.kind === 'webrtc' && x.rate_microusd != null)
            .reduce((v, x) => BigInt(x.rate_microusd) > v ? BigInt(x.rate_microusd) : v, BigInt(config.sdk_microusd));
          const rateAdvice = {
            session_id: call.id,
            current_sell_usd_per_min: m.usd(guard.prices(current, effectivePolicy, config).sell),
            suggested_sell_usd_per_min: m.usd(m.markup(observedSip + observedWeb, targetMarkup)),
            csv_update_required: observedSip > BigInt(current.rate),
            sdk_update_required: observedWeb > BigInt(config.sdk_microusd),
            markup_percent: Number(targetMarkup),
          };
          if (result.profit < 0n) await c.query(
            "UPDATE voice_guard_alerts SET details=details||$2::jsonb WHERE alert_key=$1 AND active",
            ['actual:' + call.id, JSON.stringify(rateAdvice)]);
          if (result.complete && result.cost > 0n && result.wallet < m.markup(result.cost, targetMarkup) &&
              (!guard.prices(current, effectivePolicy, config).safe || observedSip > BigInt(current.rate) || observedWeb > BigInt(config.sdk_microusd))) {
            await guard.alert('markup:' + call.id, country, prefix, 'warning',
              'Actual call revenue is below the configured markup target. Review this prefix and provider costs.',
              { ...rateAdvice, provider_usd: m.usd(result.cost), wallet_usd: m.usd(result.wallet),
                target_charge_usd: m.usd(m.markup(result.cost, targetMarkup)) }, c);
          } else if (result.complete) {
            await c.query("UPDATE voice_guard_alerts SET active=FALSE,resolved_at=NOW() WHERE alert_key=$1", ['markup:' + call.id]);
          }
          const changedRate = usage.some(
            (x) =>
              (x.kind === "sip-trunking" &&
                x.direction === "outbound" &&
                x.rate_microusd != null &&
                BigInt(x.rate_microusd) > BigInt(current.rate)) ||
              (x.kind === "webrtc" &&
                x.rate_microusd != null &&
                BigInt(x.rate_microusd) > BigInt(config.sdk_microusd)),
          );
          if (
            changed &&
            usage.some(
              (x) =>
                x.kind === "webrtc" &&
                x.rate_microusd != null &&
                BigInt(x.rate_microusd) > BigInt(config.sdk_microusd),
            )
          )
            await guard.alert(
              "sdk-rate-change",
              "",
              "",
              "warning",
              "The actual WebRTC rate exceeds the configured cost. Update the global WebRTC setting.",
              { rate_update_required: true },
              c,
            );
          if (changed && changedRate)
            await guard.alert(
              "rate-change:" + call.id,
              country,
              prefix,
              "warning",
              "Provider CDR rate is higher than the configured cost. Update this country before new calls.",
              { ...rateAdvice, rate_update_required: true },
              c,
            );
        } catch (e) {
          if (changed)
            await guard.alert(
              "route-review:" + call.id,
              country,
              prefix,
              "warning",
              "The billed call has no verified current CSV route.",
              { session_id: call.id, rate_update_required: true },
              c,
            );
        }
      }
      // Store the real known cost for Admin Profit / Call Activity. Wallet charges are never silently repriced.
      if (result.complete)
        await c.query(
          `UPDATE call_sessions SET provider_cost_usd=$2,profit_usd=$3,provider_cost_cents=$4,profit_cents=$6,
  meta=COALESCE(meta,'{}'::jsonb)||jsonb_build_object('actual_cost_audit',$5::jsonb) WHERE id=$1`,
          [
            call.id,
            m.usd(result.cost),
            m.usd(result.profit),
            Math.round(m.usd(result.cost) * 100),
            JSON.stringify({
              cost_status: status,
              provider_usd: m.usd(result.cost),
              wallet_usd: m.usd(result.wallet),
              profit_usd: m.usd(result.profit),
            }),
            Math.round(m.usd(result.profit) * 100),
          ],
        );
    });
  }
  return calls.length;
}
async function sync() {
  if (promise) return promise;
  promise = (async () => {
    const lock = await db.getClient();
    let locked = false;
    try {
      locked = (await lock.query("SELECT pg_try_advisory_lock(191912, 41) AS locked")).rows[0].locked;
      if (!locked) return { in_progress: true };
      const config = await guard.settings(lock);
      const retryAt = new Date(config.monitor_retry_after || 0).getTime();
      if (retryAt > Date.now()) return { deferred: true, retry_at: config.monitor_retry_after };
      // Manual refresh and other PM2 workers reuse a recently completed scan.
      if (!config.monitor_error && Date.now() - new Date(config.last_monitor_sync || 0).getTime() < 15000)
        return { cached: true, verified: config.monitor_verified };
      const key = process.env.TELNYX_API_KEY;
    if (!key) throw Error("Calling API key is not configured");
    if (!connections().size)
      throw Error("Calling connection IDs are not configured");
    const records = [],
      signal = AbortSignal.timeout(110000);
    let accepted = 0;
    let verifiedSip = 0,
      verifiedWeb = 0;
    for (const kind of ["sip-trunking", "webrtc"]) {
      for (let page = 1; page <= 50; page++) {
        const u = new URL("https://api.telnyx.com/v2/detail_records");
        for (const [k, v] of Object.entries({
          "filter[record_type]": kind,
          "filter[date_range]": "last_7_days",
          "page[number]": page,
          "page[size]": 100,
        }))
          u.searchParams.set(k, v);
        const data = await reports.page(u, key, signal);
        const batch = [];
        for (const row of data.data) {
          if (!connections().has(m.field(row, "connection_id", "Connection Id"))) continue;
          if (["false", "0"].includes(m.field(row, "completed").toLowerCase())) continue;
          const r = m.cdr(row, kind);
          batch.push(r);
          records.push(r);
          if (kind === "webrtc") verifiedWeb++;
          else verifiedSip++;
        }
        // Commit each validated page; a later rate limit must not discard it.
        if (batch.length) accepted += await guard.transaction(c => store(batch, c));
        const pages = Number(data.meta?.total_pages);
        if (!Number.isSafeInteger(pages) || pages < 0)
          throw Error("Unverified report pagination");
        if (page >= pages) break;
        if (page === 50)
          throw Error(
            "Report limit reached: narrow the reporting window with support",
          );
      }
    }
    const verified = config.monitor_verified || (
      verifiedSip > 0 &&
      verifiedWeb > 0 &&
      records.some(
        (r) =>
          r.kind === "sip-trunking" &&
          records.some(
            (w) =>
              w.kind === "webrtc" &&
              w.session === r.session &&
              w.to === r.to &&
              w.from === r.from,
          ),
      ));
    await db.query(
      "UPDATE voice_guard_settings SET last_monitor_sync=NOW(),monitor_error=NULL,monitor_retry_after=NULL,monitor_verified=$1 WHERE id=1",
      [verified],
    );
    const matched = await reconcile();
    await flagMissingReports();
    await guard.health();
    await db.query(
      "UPDATE voice_guard_alerts SET active=FALSE,resolved_at=NOW() WHERE alert_key='monitor' AND severity='warning'",
    );
    if (!verified)
      await guard.alert(
        "monitor",
        "",
        "",
        "warning",
        "Cost monitor needs both Calling SIP and WebRTC records before activation.",
        { sip_records: verifiedSip, webrtc_records: verifiedWeb },
      );
    return {
      accepted,
      verified: Boolean(verified),
      matched_calls: matched,
      sip_records: verifiedSip,
      webrtc_records: verifiedWeb,
    };
    } finally {
      try {
        if (locked) await lock.query("SELECT pg_advisory_unlock(191912, 41)");
      } finally { lock.release(); }
    }
  })()
    .catch(async (e) => {
      const message = String(e.message || "Calling cost sync failed").slice(
        0,
        300,
      );
      await db.query(
        "UPDATE voice_guard_settings SET monitor_error=$1,monitor_retry_after=$2 WHERE id=1",
        [message, new Date(Math.max(Date.now() + 60000, e.retryAt || 0)).toISOString()],
      );
      // Already committed pages can expose a real loss even while the provider is throttling.
      try { await reconcile(); await flagMissingReports(); }
      catch (auditError) { console.error('Calling partial report audit:', auditError.message); }
      await guard.alert(
        "monitor",
        "",
        "",
        "warning",
        "Calling cost reports are delayed. Retry is scheduled; call readiness depends on the last verified sync.",
        { message },
      );
      throw e;
    })
    .finally(() => {
      promise = null;
    });
  return promise;
}
function scheduleSync() {
  if (fastTimer) return;
  fastTimer = setTimeout(() => {
    fastTimer = null;
    void sync().catch(e => console.error('Calling fast refresh:', e.message));
  }, 1000);
  fastTimer.unref?.();
}
async function refreshPending() {
  if (localBusy) return;
  localBusy = true;
  try {
    const pending = (await db.query(`SELECT 1 FROM call_sessions s
      LEFT JOIN voice_guard_actuals a ON a.session_id=s.id
      WHERE s.ended_at IS NOT NULL AND s.ended_at>NOW()-INTERVAL '7 days'
      AND s.meta->>'calling_guard_admitted'='true'
      AND (s.tx_id IS NOT NULL OR s.status='charged')
      AND a.cost_status IS DISTINCT FROM 'sip_and_webrtc' LIMIT 1`)).rows;
    if (!pending.length) return;
    // Already imported provider records can be matched without an API request.
    await reconcile();
    scheduleSync();
  } finally { localBusy = false; }
}
function start() {
  if (timer) return;
  watchTimer = setInterval(() => {
    void watchActiveCalls().catch((e) =>
      console.error("Calling budget monitor:", e.message),
    );
  }, 3000);
  watchTimer.unref?.();
  const run = () => {
    void sync().catch((e) => console.error("Calling cost monitor:", e.message));
  };
  localTimer = setInterval(() => {
    void refreshPending().catch(e => console.error('Calling pending refresh:', e.message));
  }, 5000);
  localTimer.unref?.();
  timer = setInterval(run, 60000);
  timer.unref?.();
  setTimeout(run, 10000).unref?.();
}
function stop() {
  if (fastTimer) clearTimeout(fastTimer);
  if (localTimer) clearInterval(localTimer);
  fastTimer = null;
  localTimer = null;
  if (timer) clearInterval(timer);
  if (watchTimer) clearInterval(watchTimer);
  timer = null;
  watchTimer = null;
}
module.exports = { start, stop, sync, reconcile, store, costResult, scheduleSync, refreshPending };

async function watchActiveCalls() {
  if (watchBusy) return;
  watchBusy = true;
  try {
    const calls = (
      await db.query(`SELECT s.*,w.balance_microusd,
   EXTRACT(EPOCH FROM (NOW()-(s.answered_at AT TIME ZONE current_setting('TimeZone')))) AS elapsed
   FROM call_sessions s JOIN wallets w ON w.user_id=s.user_id
   WHERE s.ended_at IS NULL AND s.meta->>'calling_guard_admitted'='true'
   AND s.status NOT IN ('failed','charged') LIMIT 500`)
    ).rows;
    for (const call of calls) {
      if (!call.answered_at) {
        if (Date.now() - new Date(call.started_at).getTime() > 180000) {
          if (call.provider_call_id) {
            try {
              await stopProviderCall(call.provider_call_id);
            } catch (e) {
              await guard.alert(
                "budget:" + call.id,
                call.meta?.calling_rate_guard?.country_code,
                "",
                "loss",
                "Unanswered call could not be stopped. Review required.",
                { session_id: call.id },
              );
            }
          } else
            await db.query(
              "UPDATE call_sessions SET status='failed',ended_at=NOW() WHERE id=$1 AND answered_at IS NULL AND provider_call_id IS NULL AND ended_at IS NULL",
              [call.id],
            );
        }
        continue;
      }
      const snap = call.meta?.pricing_snapshot || {},
        g = call.meta?.calling_rate_guard || {};
      const dynamicLimit = guard.budgetSeconds(
        call.balance_microusd,
        m.micro(String(snap.sell_rate_usd_per_min)),
        m.micro(String(snap.customer_connection_fee_usd || 0)),
        Number(snap.minimum_duration_seconds),
        Number(snap.billing_increment_seconds),
      );
      const limit = Math.min(Number(g.max_seconds || 0), dynamicLimit);
      if (Number(call.elapsed) < limit) continue;
      if (!call.provider_call_id) {
        await guard.alert(
          "budget:" + call.id,
          g.country_code,
          g.prefix,
          "loss",
          "Call budget reached but provider call ID is missing. Immediate review required.",
          { session_id: call.id },
        );
        continue;
      }
      try {
        await stopProviderCall(call.provider_call_id);
        await db.query(
          "UPDATE call_sessions SET meta=meta||jsonb_build_object('calling_budget_hangup_requested_at',NOW()) WHERE id=$1",
          [call.id],
        );
      } catch (e) {
        await guard.alert(
          "budget:" + call.id,
          g.country_code,
          g.prefix,
          "loss",
          "Automatic call stop failed at the wallet budget. Check the active call.",
          { session_id: call.id },
        );
      }
    }
  } finally {
    watchBusy = false;
let fastTimer = null, localTimer = null, localBusy = false;
  }
}
module.exports.watchActiveCalls = watchActiveCalls;

async function stopProviderCall(id) {
  if (!process.env.TELNYX_API_KEY) throw Error("Calling API key missing");
  const response = await fetch(
    "https://api.telnyx.com/v2/calls/" +
      encodeURIComponent(id) +
      "/actions/hangup",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.TELNYX_API_KEY,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    },
  );
  if (!response.ok) throw Error("Provider hangup was not acknowledged");
  await response.body?.cancel();
}
async function flagMissingReports() {
  const rows = (
    await db.query(`SELECT s.id,s.meta->'calling_rate_guard'->>'country_code' AS country,
 s.meta->'calling_rate_guard'->>'prefix' AS prefix FROM call_sessions s
 WHERE s.meta->>'calling_guard_admitted'='true'
 AND (s.answered_at IS NOT NULL OR s.tx_id IS NOT NULL)
 AND s.ended_at<NOW()-INTERVAL '15 minutes'
 AND s.ended_at>NOW()-INTERVAL '7 days' AND NOT EXISTS(
 SELECT 1 FROM voice_guard_actuals a WHERE a.session_id=s.id AND a.cost_status='sip_and_webrtc') LIMIT 100`)
  ).rows;
  for (const row of rows)
    await guard.alert(
      "missing:" + row.id,
      row.country,
      row.prefix,
      "warning",
      "Cost report pending for this prefix. Profit is not yet verified. Changing markup will not match the missing report.",
      { session_id: row.id, cost_report_required: true },
    );
  await db.query(`UPDATE voice_guard_alerts a SET active=FALSE,resolved_at=NOW()
 WHERE a.alert_key LIKE 'missing:%' AND EXISTS(SELECT 1 FROM voice_guard_actuals x
 WHERE a.details->>'session_id'=x.session_id::text AND x.cost_status='sip_and_webrtc')`);
  await db.query(`UPDATE voice_guard_alerts a SET active=FALSE,resolved_at=NOW()
 WHERE a.alert_key LIKE 'missing:%' AND EXISTS(SELECT 1 FROM call_sessions s
 WHERE a.details->>'session_id'=s.id::text AND s.ended_at IS NOT NULL AND s.answered_at IS NULL
 AND s.tx_id IS NULL AND COALESCE(s.charged_amount_usd,0)=0)`);
}
module.exports.stopProviderCall = stopProviderCall;

module.exports.reportingConnections = connections;
