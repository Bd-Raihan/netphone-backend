'use strict';

// Current-action alerts are separate from immutable historical call results.
// A repaired price never changes an old wallet debit or an actual-cost record.
const REVIEWABLE = /^(actual|markup|rate-change|route-review|manual):/;
function isReportNotice(a) {
  return /^(missing|partial):/.test(a.alert_key || '') && a.severity === 'warning';
}
function groupAlerts(alerts) {
  const groups = new Map();
  for (const a of alerts) {
    const key = REVIEWABLE.test(a.alert_key) && a.country_code
      ? `pricing:${a.country_code}:${a.prefix}` : a.alert_key;
    const old = groups.get(key);
    if (!old) groups.set(key, {...a, related_alert_count:1});
    else {
      old.related_alert_count++;
      if (a.severity === 'loss') old.severity = 'loss';
      // Never discard a required CSV/SDK fix when combining notices.
      old.details = {...a.details, ...old.details,
        csv_update_required: !!(a.details?.csv_update_required || old.details?.csv_update_required),
        sdk_update_required: !!(a.details?.sdk_update_required || old.details?.sdk_update_required)};
    }
  }
  return [...groups.values()];
}
function currentRisk({route, config, price, usage, requireObserved}) {
  if (!price.safe) return 'Current retail rate does not cover provider costs.';
  const sip = usage.filter(x => x.kind === 'sip-trunking' && x.direction === 'outbound' && x.rate_microusd != null);
  const web = usage.filter(x => x.kind === 'webrtc' && x.rate_microusd != null);
  if (sip.some(x => BigInt(x.rate_microusd) > BigInt(route.rate))) return 'Updated Telnyx SIP CSV is still required.';
  if (web.some(x => BigInt(x.rate_microusd) > BigInt(config.sdk_microusd))) return 'WebRTC provider cost still needs updating.';
  if (requireObserved && (!sip.length || !web.length)) return 'Both provider rate reports are needed to verify this loss.';
  return null;
}
async function reconcile(api, actor = null) {
  return api.transaction(async c => {
    await c.query('SELECT id FROM voice_guard_settings WHERE id=1 FOR UPDATE');
    const config = await api.settings(c);
    if (!config.deck_version) return {resolved:0};
    const alerts = (await c.query("SELECT * FROM voice_guard_alerts WHERE active AND (alert_key ~ '^(actual|markup|rate-change|route-review|manual):' OR alert_key='sdk-rate-change') ORDER BY alert_key FOR UPDATE")).rows;
    if (!alerts.length) return {resolved:0};
    const ids = [...new Set(alerts.map(a => String(a.details?.session_id || '')).filter(x => /^\d+$/.test(x)))];
    const calls = (await c.query('SELECT id,to_phone_e164,meta FROM call_sessions WHERE id=ANY($1::bigint[])', [ids])).rows;
    const sessions = [...new Set(calls.map(x => x.meta?.telnyx_call_session_id).filter(Boolean))];
    const legs = [...new Set(calls.map(x => x.meta?.telnyx_call_leg_id).filter(Boolean))];
    const usages = sessions.length || legs.length ? (await c.query('SELECT session_uuid,leg_id,to_number,from_number,kind,direction,rate_microusd FROM voice_guard_usage WHERE session_uuid=ANY($1::uuid[]) OR leg_id=ANY($2::text[])', [sessions,legs])).rows : [];
    const callMap = new Map(calls.map(x => [String(x.id),x]));
    let countryRows;
    const resolved = [], checked = new Map();
    for (const a of alerts) {
      let reason;
      if (a.alert_key === 'sdk-rate-change') {
        const high = (await c.query("SELECT 1 FROM voice_guard_usage WHERE kind='webrtc' AND updated_at>NOW()-INTERVAL '7 days' AND rate_microusd>$1 LIMIT 1",[config.sdk_microusd])).rows;
        reason = high.length ? 'WebRTC rate exceeds configured cost.' : null;
      } else if (a.alert_key.startsWith('manual:')) {
        countryRows ||= await api.countries();
        const items = countryRows.filter(x => x.country_code === a.country_code);
        reason = !items.length || items.some(x => x.profit_usd_per_min <= 0) ? 'Manual price still needs review.' : null;
      } else {
        const call = callMap.get(String(a.details?.session_id));
        if (!call) continue; // Unverifiable legacy evidence must not be silently cleared.
        const checkKey = `${call.id}:${a.country_code}:${a.alert_key.startsWith('actual:') || a.alert_key.startsWith('rate-change:')}`;
        if (checked.has(checkKey)) reason = checked.get(checkKey);
        else {
          try {
            const route = await api.selectRoute(call.to_phone_e164,config,c);
            const policy = await api.policy(call.to_phone_e164,a.country_code,c);
            const digits = v => String(v || '').replace(/[^0-9]/g,'');
            const usage = usages.filter(x => ((call.meta?.telnyx_call_session_id && x.session_uuid === call.meta.telnyx_call_session_id) || (call.meta?.telnyx_call_leg_id && x.leg_id === call.meta.telnyx_call_leg_id)) && digits(x.to_number) === digits(call.to_phone_e164) && digits(x.from_number) === digits(call.meta?.provider_phone_number || config.caller_number));
            reason = currentRisk({route,config,price:api.prices(route,policy,config),usage,
              requireObserved:a.alert_key.startsWith('actual:') || a.alert_key.startsWith('rate-change:')});
          } catch (e) {
            // Route ambiguity/missing data stays visible; SQL errors abort the transaction.
            if (e.code || /connection|database|syntax/i.test(e.message)) throw e;
            reason = 'Current CSV route could not be verified.';
          }
          checked.set(checkKey, reason);
        }
      }
      if (!reason) resolved.push(a.alert_key);
    }
    if (resolved.length) {
      await c.query('UPDATE voice_guard_alerts SET active=FALSE,resolved_at=NOW(),resolved_by=$2 WHERE alert_key=ANY($1::text[]) AND active',[resolved,actor]);
      await api.audit(c,actor,'calling_current_prices_verified',{deck_version:config.deck_version,resolved_alert_keys:resolved});
    }
    return {resolved:resolved.length};
  });
}
module.exports = {reconcile, currentRisk, groupAlerts, isReportNotice};
