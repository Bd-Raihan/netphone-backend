"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm"),
  path = require("node:path");
const base = path.join(__dirname, "../src/modules");
const m = require(path.join(base, "calling-guard/money-routes"));
function load(file, stubs = {}) {
  const mod = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(base, file), "utf8"),
    {
      module: mod,
      exports: mod.exports,
      require: (n) => (n in stubs ? stubs[n] : require(n)),
      process,
      console,
      Date,
      URL,
      AbortSignal,
      fetch,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    },
    { filename: file },
  );
  return mod.exports;
}
const guard = load("calling-guard/guard.service.js", {
  "../../config/db": {},
  "./money-routes": m,
});
const monitor = load("calling-guard/cost-monitor.js", {
  "../../config/db": {},
  "./guard.service": guard,
  "./money-routes": m,
});
const row = (p, rate, origin = "", extra = {}) => ({
  prefix: p,
  fixed: p.match(/^\d+/)[0],
  rate: m.micro(rate).toString(),
  fee: "0",
  origin,
  first: 60,
  next: 60,
  exact: false,
  iso: "IT",
  country: "Italy",
  ...extra,
});
test("strict USD parsing, upward markup, and configured SDK cost", () => {
  assert.equal(m.micro("0.2501"), 250100n);
  assert.equal(m.markup(252100n, 30), 327730n);
  assert.equal(m.pricing(row("393", "0.2501")).sell, 327730n);
  assert.equal(m.markup(1n, 30), 2n);
  assert.equal(m.markup(6100n, 32.79), 8101n);
  for (const bad of ["NaN", "-1", "0.0000001", "1e-3", "Infinity"])
    assert.throws(() => m.micro(bad));
  assert.throws(() => m.markup(100n, 30.001));
});
test("longest destination and eligible origin, not cheapest country row", () => {
  const rows = [
    row("39", "0.0101"),
    row("39", "0.0061", "33"),
    row("393", "0.2501"),
    row("393", "0.0301", "33"),
  ];
  assert.equal(m.select(rows, "+393331234567", "+16452199033").rate, "250100");
  assert.equal(m.select(rows, "+393331234567", "+33123456789").rate, "30100");
  assert.equal(m.select(rows, "+39060608", "+16452199033").rate, "10100");
  assert.equal(
    m.select(
      [row("39", "0.0101"), row("393", "0.0301", "33")],
      "+393331234567",
      "+16452199033",
    ).rate,
    "10100",
  );
  assert.throws(
    () =>
      m.select([row("393", "0.0301", "33")], "+393331234567", "+16452199033"),
    /Origin restrictions/,
  );
});
test("wildcards, exact routes, ambiguity and local restrictions fail safely", () => {
  assert.equal(
    m.select([row("393X", "0.2")], "+39331234567", "+16452199033").prefix,
    "393X",
  );
  assert.throws(
    () =>
      m.select(
        [row("39060608", "0.1", "", { exact: true })],
        "+390606081",
        "+16452199033",
      ),
    /No matching/,
  );
  assert.throws(
    () =>
      m.select(
        [row("39", "0.1"), row("39", "0.2")],
        "+39060608",
        "+16452199033",
      ),
    /Ambiguous/,
  );
  assert.equal(m.originLength(row("39", "0.1", "local"), "+39333123456"), -1);
});
test("manual price can reduce profit but cannot quote at or below cost", () => {
  assert.equal(
    m.pricing(row("39", "0.01"), {
      pricing_mode: "manual_rate",
      manual_sell_rate_usd_per_min: "0.013",
    }).safe,
    true,
  );
  assert.equal(
    m.pricing(row("39", "0.01"), {
      pricing_mode: "manual_rate",
      manual_sell_rate_usd_per_min: "0.012",
    }).safe,
    false,
  );
  assert.equal(
    m.pricing(row("39", "0.01"), { markup_percent: 10 }).sell,
    13200n,
  );
});
test("first/next intervals and the independent SDK minimum fit wallet budget", () => {
  assert.equal(m.seconds(61, 60, 60), 120);
  assert.equal(m.seconds(46, 45, 60), 105);
  assert.equal(guard.budgetSeconds(327730, 327730, 0, 60, 60), 50);
  assert.equal(guard.budgetSeconds(1000, 1000000, 0, 1, 1), 0);
  assert.equal(guard.budgetSeconds(1000000, 1000000, 0, 1, 1), 50);
  assert.equal(guard.budgetSeconds(1000000000, 10000, 0, 60, 60), 7200);
  for (let duration = 1; duration < 800; duration++) {
    const sip = m.seconds(duration, 45, 60),
      sdk = m.seconds(duration, 60, 60),
      customer = Math.max(sip, sdk);
    const quoted = m.markup(12000n, 30) * BigInt(customer);
    assert.ok(
      quoted >= ((10000n * BigInt(sip) + 2000n * BigInt(sdk)) * 130n) / 100n,
    );
  }
});
test("provider totals sum all legs; incomplete costs remain explicitly partial", () => {
  const u = [
    { kind: "sip-trunking", cost_microusd: "250100" },
    { kind: "webrtc", cost_microusd: "2000" },
    { kind: "webrtc", cost_microusd: "2000" },
  ];
  const b = monitor.costResult(u, "200000");
  assert.equal(b.cost, 254100n);
  assert.equal(b.profit, -54100n);
  assert.equal(b.complete, true);
  assert.equal(monitor.costResult(u.slice(0, 1), "200000").complete, false);
});
test("documented Telnyx WebRTC schema uses telnyx_session_id, not SDK registration session_id", () => {
  const r = m.cdr(
    {
      id: "leg1",
      telnyx_session_id: "4b679edc-b7e7-11ef-adfb-02420aef3920",
      session_id: "wrong-registration",
      connection_id: "123",
      cli: "+15127376291",
      cld: "+18008648331",
      currency: "USD",
      rate: "0.002",
      cost: "0.002",
      billed_sec: 60,
      direction: "outbound",
      telnyx_leg_id: "leg1",
    },
    "webrtc",
  );
  assert.equal(r.session, "4b679edc-b7e7-11ef-adfb-02420aef3920");
  assert.equal(r.cost, "2000");
  assert.equal(r.seconds, 60);
  assert.throws(
    () => m.cdr({ id: "x", connection_id: "123" }, "webrtc"),
    /Incomplete/,
  );
});
test("stale source, changed caller and delayed reports cannot pass readiness", () => {
  process.env.TELNYX_PHONE_NUMBER = "+16452199033";
  const s = {
    deck_version: "version",
    caller_number: process.env.TELNYX_PHONE_NUMBER,
    imported_at: new Date(),
    max_deck_age_days: 30,
    monitor_verified: true,
    last_monitor_sync: new Date(),
  };
  assert.equal(guard.readiness(s), null);
  assert.match(
    guard.readiness({
      ...s,
      imported_at: new Date(Date.now() - 31 * 86400000),
    }),
    /stale/,
  );
  assert.match(
    guard.readiness({ ...s, caller_number: "+12125550123" }),
    /Caller ID/,
  );
  assert.match(
    guard.readiness({
      ...s,
      last_monitor_sync: new Date(Date.now() - 16 * 60000),
    }),
    /monitor/,
  );
});
test("new admin endpoints stay behind JWT and Admin middleware", () => {
  const s = fs.readFileSync(
    path.join(base, "admin-country-pricing/admin-country-pricing.routes.js"),
    "utf8",
  );
  assert.ok(
    s.indexOf("router.use(requireAdmin)") <
      s.indexOf("router.get('/guard/status'"),
  );
  assert.ok(
    s.indexOf("router.use(authRequired)") <
      s.indexOf("router.post('/guard/sync'"),
  );
});
test("safe routing cannot fall through to a legacy cheaper quote", async () => {
  const router = load("calls/provider-router.service.js", {
    "./provider-router.repository": {},
    "../calling-guard/guard.service": {
      tryResolve: async () => ({ ok: false, reason: "country_loss_blocked" }),
    },
  });
  assert.equal(
    (await router.resolveDestination("+393331234567")).reason,
    "country_loss_blocked",
  );
});
const suppliedDeck = process.env.CALLING_RATE_CSV;
test(
  "provided full CSV retains origin variants and exact destination costs",
  { skip: !suppliedDeck },
  async () => {
    const rows = [];
    const count = await m.readDeck(suppliedDeck, async (batch) => {
      for (const r of batch)
        if (["IT", "BD", "IN", "US"].includes(r.iso.split("/")[0]))
          rows.push(r);
    });
    assert.equal(count, 264076);
    const from = "+16452199033";
    assert.equal(m.select(rows, "+393331234567", from).rate, "250100");
    assert.equal(m.select(rows, "+39060608", from).rate, "10100");
    assert.equal(m.select(rows, "+8801712345678", from).rate, "20100");
    assert.equal(m.select(rows, "+917001234567", from).rate, "35100");
    assert.equal(m.select(rows, "+12125551234", from).rate, "5000");
  },
);

test("auto billing applies 30% to separate SIP and SDK billed durations", () => {
  const b = m.billUsage(
    row("39", "0.01", "", { first: 45, next: 60 }),
    { markup_percent: 30 },
    2000,
    46,
  );
  assert.equal(b.sipSeconds, 105);
  assert.equal(b.sdkSeconds, 60);
  assert.equal(b.providerUsage, 19500n);
  assert.equal(b.sellUsage, 25350n);
});
