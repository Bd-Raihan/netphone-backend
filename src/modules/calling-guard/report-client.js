"use strict";
const sleep = (ms, signal) => require('node:timers/promises').setTimeout(ms, undefined, { signal });
function retryTime(value, now = Date.now()) {
  if (value == null || String(value).trim() === '') return now + 60000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(now, date) : now + 60000;
}
async function page(url, key, signal, deps = {}) {
  const request = deps.fetch || fetch, wait = deps.sleep || sleep;
  for (let attempt = 0; attempt < 3; attempt++) {
    // Serial calls, including page transitions, avoid a burst against reporting.
    await wait(1000, signal);
    const response = await request(url, {
      headers: { Authorization: 'Bearer ' + key }, signal, redirect: 'error',
    });
    if (response.ok) {
      const text = await response.text();
      if (text.length > 8 * 1024 * 1024) throw Error('Provider response too large');
      const data = JSON.parse(text);
      if (!Array.isArray(data.data)) throw Error('Unverified Calling report schema');
      return data;
    }
    const retryAt = retryTime(response.headers.get('retry-after'));
    await response.body?.cancel();
    const retryable = response.status === 429 || response.status >= 500;
    const delay = Math.max(1000 * 2 ** attempt, retryAt - Date.now());
    if (retryable && attempt < 2 && delay <= 15000) {
      await wait(delay, signal);
      continue;
    }
    const error = Error('Calling reporting API failed (HTTP ' + response.status + ')');
    if (retryable) error.retryAt = retryAt;
    throw error;
  }
}
module.exports = { page, retryTime };
