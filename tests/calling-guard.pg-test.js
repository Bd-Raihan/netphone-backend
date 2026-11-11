"use strict";
// Optional local integration check: npm install --no-save --package-lock=false @electric-sql/pglite
// Does not connect to the production PostgreSQL server or Telnyx.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm"),
  path = require("node:path"),
  os = require("node:os");
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const base = path.join(__dirname, "../src/modules"),
  m = require(path.join(base, "calling-guard/money-routes"));
function load(file, stubs) {
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(base, file), "utf8"),
    {
      module,
      exports: module.exports,
      require: (n) => (n in stubs ? stubs[n] : require(n)),
      process,
      console,
      Date,
      URL,
      AbortSignal,
      fetch: stubs.__fetch || fetch,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    },
    { filename: file },
  );
  return module.exports;
}
(async () => {
  const pg = new PGlite();
  await pg.waitReady;
  const db = {
    query: (q, p) => pg.query(q, p),
    getClient: async () => ({ query: (q, p) => pg.query(q, p), release() {} }),
  };
  db.pool = { connect: db.getClient };
  const repo = {
    findDestinationPolicy: async () => ({ is_enabled: true }),
    findActiveRoute: async () => ({ id: 1, country_code: "IT" }),
    findRouteProviderCandidates: async () => [
      {
        provider_id: 1,
        provider_code: "telnyx",
        provider_name: "Telnyx",
        provider_plan_id: 1,
        provider_plan_code: "payg",
        id: 1,
      },
    ],
  };
  const guard = load("calling-guard/guard.service.js", {
    "../../config/db": db,
    "./money-routes": m,
    "../calls/provider-router.repository": repo,
  });
  const monitor = load("calling-guard/cost-monitor.js", {
    "../../config/db": db,
    "./guard.service": guard,
    "./money-routes": m,
  });
  await pg.exec(`CREATE TABLE users(id BIGINT PRIMARY KEY);
 INSERT INTO users VALUES(1);
 CREATE TABLE wallets(user_id BIGINT PRIMARY KEY,balance_microusd BIGINT NOT NULL);
 INSERT INTO wallets VALUES(1,2000000);
 CREATE TABLE voice_routes(id BIGSERIAL PRIMARY KEY,country_code TEXT,prefix TEXT,is_active BOOLEAN);
 INSERT INTO voice_routes(country_code,prefix,is_active) VALUES('IT','39',TRUE),('BD','880',TRUE);
 CREATE TABLE call_sessions(id BIGSERIAL PRIMARY KEY,user_id BIGINT,to_phone_e164 TEXT,route_id BIGINT,provider TEXT,status TEXT,started_at TIMESTAMPTZ DEFAULT NOW(),answered_at TIMESTAMP,ended_at TIMESTAMPTZ,meta JSONB DEFAULT '{}',provider_call_id TEXT,duration_sec INTEGER,provider_cost_usd NUMERIC,profit_usd NUMERIC,provider_cost_cents INTEGER,profit_cents INTEGER);
 CREATE TABLE wallet_transactions(id BIGSERIAL PRIMARY KEY,user_id BIGINT,type TEXT,status TEXT,idempotency_key TEXT,amount_microusd BIGINT,meta JSONB);`);
  const migration = fs.readFileSync(
    path.join(__dirname, "../database/migrations/039_calling_rate_guard.sql"),
    "utf8",
  );
  await pg.exec(migration);
  await pg.exec(migration);
  process.env.TELNYX_PHONE_NUMBER = "+16452199033";
  assert.equal(
    (await guard.tryResolve("+39060608")).reason,
    "safe_calling_activation_required",
  );
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "netphone-deck-")),
    file = path.join(temp, "sample.csv");
  fs.writeFileSync(
    file,
    "ISO,Country,Origination Prefixes,Destination Prefixes,Description,Interval 1,Interval N,Rate,Price Per Call,Exact Match\nIT,Italy,,39,Fixed,60,60,0.0101,0,NO\nIT,Italy,33,39,EEA Fixed,60,60,0.0061,0,NO\nIT,Italy,,393,Mobile,60,60,0.2501,0,NO\nIT,Italy,33,393,EEA Mobile,60,60,0.0301,0,NO\nBD,Bangladesh,,880,All,1,1,0.0201,0,NO\n",
  );
  const imported = await guard.importDeck({ filePath: file, adminUserId: 1 });
  assert.equal(imported.unique_rates_imported, 5);
  const dup = await guard.importDeck({ filePath: file, adminUserId: 1 });
  assert.equal(dup.duplicate_import, true);
  await pg.query(
    "UPDATE voice_guard_settings SET monitor_verified=TRUE,last_monitor_sync=NOW() WHERE id=1",
  );
  await guard.enable(true, 1);
  assert.equal(
    (await guard.resolve("+393331234567")).pricing.sell_rate_usd_per_min,
    0.32773,
  );
  let italy = (await guard.countries()).find((x) => x.country_code === "IT");
  assert.equal(italy.provider_cost_usd_per_min, 0.0121);
  assert.equal(italy.provider_max_usd_per_min, 0.2521);
  assert.equal(italy.sell_max_usd_per_min, 0.32773);
  assert.equal(italy.has_loss, false);
  await guard.saveRoutePolicy({
    prefix: "393",
    adminUserId: 1,
    payload: {
      country_code: "IT",
      pricing_mode: "manual_rate",
      manual_sell_rate_usd_per_min: "0.27",
    },
  });
  italy = (await guard.countries()).find((x) => x.country_code === "IT");
  assert.equal(italy.sell_max_usd_per_min, 0.27);
  assert.equal(
    (await guard.resolve("+393331234567")).pricing.sell_rate_usd_per_min,
    0.27,
  );
  await guard.saveRoutePolicy({
    prefix: "393",
    adminUserId: 1,
    payload: {
      country_code: "IT",
      pricing_mode: "manual_rate",
      manual_sell_rate_usd_per_min: "0.01",
    },
  });
  assert.equal(
    (await guard.resolve("+393331234567")).reason,
    "country_loss_blocked",
  );
  assert.equal((await guard.getCountry("39", "IT")).has_loss, true);
  await assert.rejects(guard.resolveAlert("manual:IT", 1), /below-cost/);
  await guard.saveRoutePolicy({
    prefix: "393",
    adminUserId: 1,
    payload: {
      country_code: "IT",
      pricing_mode: "auto_markup",
      markup_percent: 30,
    },
  });
  await guard.resolveAlert("manual:IT", 1);
  assert.equal((await guard.resolve("+393331234567")).ok, true);
  await guard.saveCountry({
    prefix: "39",
    adminUserId: 1,
    payload: {
      country_code: "IT",
      pricing_mode: "auto_markup",
      markup_percent: 20,
      is_active: true,
    },
  });
  assert.equal(
    (await guard.resolve("+39060608")).pricing.sell_rate_usd_per_min,
    0.01452,
  );
  assert.equal(
    (await guard.resolve("+393331234567")).pricing.sell_rate_usd_per_min,
    0.32773,
  ); // prefix override wins
  await guard.resetCountry({ prefix: "39", countryCode: "IT", adminUserId: 1 });
  assert.equal(
    (await guard.routeRows("39", { country_code: "IT" })).items.length,
    2,
  );
  await guard.saveCountry({
    prefix: "39",
    adminUserId: 1,
    payload: {
      country_code: "IT",
      pricing_mode: "auto_markup",
      markup_percent: 30,
      is_active: false,
    },
  });
  assert.equal(
    (await guard.resolve("+393331234567")).reason,
    "destination_disabled",
  );
  await guard.saveCountry({
    prefix: "39",
    adminUserId: 1,
    payload: {
      country_code: "IT",
      pricing_mode: "auto_markup",
      markup_percent: 30,
      is_active: true,
    },
  });
  // Match provider records to a real posted wallet debit. Repeated CDR sync must not create a second debit.
  const sid = "4b679edc-b7e7-11ef-adfb-02420aef3920";
  await pg.query(
    `INSERT INTO call_sessions(id,user_id,to_phone_e164,route_id,provider,status,started_at,answered_at,ended_at,meta)
 VALUES(1,1,'+393331234567',1,'telnyx','charged',NOW()-INTERVAL '12 minutes',NOW()-INTERVAL '11 minutes',NOW()-INTERVAL '10 minutes',$1)`,
    [
      JSON.stringify({
        provider_phone_number: process.env.TELNYX_PHONE_NUMBER,
        telnyx_call_session_id: sid,
        calling_rate_guard: { country_code: "IT", prefix: "393" },
      }),
    ],
  );
  await pg.query(
    "INSERT INTO wallet_transactions(user_id,type,status,idempotency_key,amount_microusd,meta) VALUES(1,'call_charge','posted','call_charge:1',15000,'{\"session_id\":1}')",
  );
  const records = [
    {
      kind: "sip-trunking",
      key: "sip1",
      session: sid,
      leg: "sip1",
      connection: "conn",
      from: "16452199033",
      to: "393331234567",
      cost: "250100",
      seconds: 60,
      rate: "250100",
      direction: "outbound",
    },
    {
      kind: "webrtc",
      key: "web1",
      session: sid,
      leg: "web1",
      connection: "conn",
      from: "16452199033",
      to: "393331234567",
      cost: "2000",
      seconds: 60,
      rate: "2000",
      direction: "outbound",
    },
  ];
  await guard.transaction((c) => monitor.store(records, c));
  await guard.transaction((c) => monitor.store(records, c));
  assert.equal(
    (await pg.query("SELECT COUNT(*) FROM voice_guard_usage")).rows[0].count,
    2,
  );
  await monitor.reconcile();
  await monitor.reconcile();
  let bill = (
    await pg.query("SELECT * FROM voice_guard_actuals WHERE session_id=1")
  ).rows[0];
  assert.equal(bill.profit_microusd, -237100);
  assert.equal(bill.cost_status, "sip_and_webrtc");
  assert.equal(
    (await pg.query("SELECT COUNT(*) FROM wallet_transactions")).rows[0].count,
    1,
  );
  assert.equal((await guard.getCountry("39", "IT")).has_loss, true);
  assert.equal(
    (await guard.resolve("+393331234567")).reason,
    "country_loss_blocked",
  );
  await assert.rejects(
    guard.transaction((c) =>
      monitor.store([{ ...records[0], to: "39060608" }], c),
    ),
    /identity changed/,
  );
  // Source fixes allow a reviewed historical loss to remain documented without charging it again.
  await guard.resolveAlert("actual:1", 1);
  assert.equal((await guard.resolve("+393331234567")).ok, true);
  await pg.query(
    "INSERT INTO wallet_transactions(user_id,type,status,amount_microusd,meta) VALUES(1,'refund','posted',1000,'{\"session_id\":1}')",
  );
  await monitor.reconcile();
  bill = (
    await pg.query("SELECT * FROM voice_guard_actuals WHERE session_id=1")
  ).rows[0];
  assert.equal(bill.wallet_microusd, 14000);
  await guard.resolveAlert("actual:1", 1);
  // Admission lock + wallet budget: do not admit overlapping app calls for the same wallet.
  await pg.query(
    "INSERT INTO call_sessions(id,user_id,to_phone_e164,provider,status,meta) VALUES(2,1,'+39060608','telnyx','started','{\"calling_rate_guard\":{\"country_code\":\"IT\"}}'),(3,1,'+39060608','telnyx','started','{}')",
  );
  const quoted = {
    sell_rate_usd_per_min: 0.01573,
    customer_connection_fee_usd: 0,
    minimum_duration_seconds: 60,
    billing_increment_seconds: 60,
  };
  const admissionMeta = {
    calling_rate_guard: {
      version: (await guard.settings()).deck_version,
      country_code: "IT",
    },
  };
  const admitted = await guard.admit(
    { id: 2, user_id: 1, meta: admissionMeta },
    quoted,
  );
  assert.ok(admitted.meta.calling_rate_guard.max_seconds > 0);
  await assert.rejects(
    guard.admit({ id: 3, user_id: 1, meta: admissionMeta }, quoted),
    /already active/,
  );
  await pg.query(
    "UPDATE call_sessions SET ended_at=NOW(),answered_at=NOW(),status='completed' WHERE id=2",
  );
  await assert.rejects(
    guard.admit({ id: 3, user_id: 1, meta: admissionMeta }, quoted),
    /already active/,
  );
  // Execute the real call finalizer and the unchanged real Wallet service.
  await pg.exec(`ALTER TABLE wallets ADD COLUMN currency TEXT DEFAULT 'USD',ADD COLUMN balance_cents INTEGER DEFAULT 200,ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
 ALTER TABLE wallet_transactions ADD COLUMN amount_cents INTEGER,ADD COLUMN balance_after_cents INTEGER,ADD COLUMN balance_after_microusd BIGINT,ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW();
 CREATE UNIQUE INDEX wallet_idempotency_test ON wallet_transactions(user_id,idempotency_key);
 ALTER TABLE call_sessions ADD COLUMN tx_id BIGINT,ADD COLUMN provider_status TEXT,ADD COLUMN charged_minutes INTEGER,ADD COLUMN charged_amount_cents INTEGER,ADD COLUMN charged_amount_usd NUMERIC,ADD COLUMN billing_source TEXT,ADD COLUMN status_callback_payload JSONB;`);
  const wallet = load("wallet/wallet.service.js", { "../../config/db": db });
  const calls = load("calls/calls.service.js", {
    "../../config/db": db,
    "../calling-guard/guard.service": guard,
    "../calling-guard/money-routes": m,
    "../wallet/wallet.service": wallet,
    "./provider-router.service": {},
  });
  const meta = {
    calling_rate_guard: {
      pricing_mode: "auto_markup",
      markup_percent: 30,
      sdk_microusd: "2000",
    },
    pricing_snapshot: {
      sell_rate_usd_per_min: 0.0156,
      raw_provider_rate_usd_per_min: 0.01,
      total_provider_cost_usd_per_min: 0.012,
      minimum_duration_seconds: 45,
      billing_increment_seconds: 60,
      provider_connection_fee_usd: 0,
      customer_connection_fee_usd: 0,
    },
  };
  await pg.query(
    "INSERT INTO call_sessions(id,user_id,to_phone_e164,provider,status,answered_at,ended_at,meta) VALUES(10,1,'+39060608','telnyx','completed',NOW()-INTERVAL '2 minutes',NOW(),$1)",
    [JSON.stringify(meta)],
  );
  const before = Number(
    (await pg.query("SELECT balance_microusd FROM wallets WHERE user_id=1"))
      .rows[0].balance_microusd,
  );
  const charged = await calls.billCompletedCallByProvider({
    sessionId: 10,
    rawPayload: { duration_seconds: 46 },
  });
  assert.equal(charged.ok, true);
  assert.equal(charged.charged_amount_microusd, 25350);
  assert.equal(
    Number(
      (await pg.query("SELECT balance_microusd FROM wallets WHERE user_id=1"))
        .rows[0].balance_microusd,
    ),
    before - 25350,
  );
  const repeat = await calls.billCompletedCallByProvider({
    sessionId: 10,
    rawPayload: { duration_seconds: 46 },
  });
  assert.equal(repeat.reason, "already_charged");
  assert.equal(
    Number(
      (await pg.query("SELECT balance_microusd FROM wallets WHERE user_id=1"))
        .rows[0].balance_microusd,
    ),
    before - 25350,
  );
  // A WebRTC cost rise pauses every country, even before a second country loses money.
  await guard.transaction((c) =>
    monitor.store([{ ...records[1], cost: "3000", rate: "3000" }], c),
  );
  await monitor.reconcile();
  assert.ok(
    (await guard.health()).alerts.some(
      (x) => x.alert_key === "sdk-rate-change",
    ),
  );
  assert.equal(
    (await guard.resolve("+39060608")).reason,
    "country_loss_blocked",
  );
  await assert.rejects(guard.resolveAlert("sdk-rate-change", 1), /understates/);
  await guard.configure({ max_deck_age_days: 30, sdk_usd_per_min: "0.003" }, 1);
  await guard.resolveAlert("sdk-rate-change", 1);
  // Exercise the real HTTP sync orchestration using documented CDR fixtures, not the network.
  process.env.TELNYX_API_KEY = "test-key-not-a-real-secret";
  process.env.TELNYX_SIP_CONNECTION_ID = "conn";
  const syncMonitor = load("calling-guard/cost-monitor.js", {
    "../../config/db": db,
    "./guard.service": guard,
    "./money-routes": m,
    __fetch: async (url) => {
      const kind = new URL(url).searchParams.get("filter[record_type]");
      const original = records.find((x) => x.kind === kind);
      const raw = {
        id: original.key,
        telnyx_session_id: sid,
        telnyx_leg_id: original.leg,
        connection_id: "conn",
        cli: "+16452199033",
        cld: "+393331234567",
        currency: "USD",
        completed: true,
        billed_sec: 60,
        direction: "outbound",
        cost: kind === "webrtc" ? "0.003" : "0.2501",
        rate: kind === "webrtc" ? "0.003" : "0.2501",
      };
      return {
        ok: true,
        text: async () =>
          JSON.stringify({ data: [raw], meta: { total_pages: 1 } }),
      };
    },
  });
  const synced = await syncMonitor.sync();
  assert.equal(synced.verified, true);
  assert.equal(synced.matched_calls, 1);
  const brokenMonitor = load("calling-guard/cost-monitor.js", {
    "../../config/db": db,
    "./guard.service": guard,
    "./money-routes": m,
    __fetch: async () => ({ ok: false, status: 403 }),
  });
  await assert.rejects(brokenMonitor.sync(), /HTTP 403/);
  assert.equal(
    (await guard.resolve("+39060608")).reason,
    "calling_guard_not_ready",
  );
  // Watchdog uses the server-side cap, and abandoned unsigned app sessions expire.
  let stopped = 0;
  const watchdog = load("calling-guard/cost-monitor.js", {
    "../../config/db": db,
    "./guard.service": guard,
    "./money-routes": m,
    __fetch: async (url) => {
      assert.match(String(url), /calls\/test_control_id\/actions\/hangup$/);
      stopped++;
      return { ok: true, body: { cancel: async () => {} } };
    },
  });
  const activeMeta = {
    ...meta,
    calling_guard_admitted: true,
    calling_rate_guard: {
      ...meta.calling_rate_guard,
      max_seconds: 50,
      country_code: "IT",
      prefix: "39",
    },
  };
  await pg.query(
    "INSERT INTO call_sessions(id,user_id,to_phone_e164,provider,status,started_at,answered_at,provider_call_id,meta) VALUES(20,1,'+39060608','telnyx','started',NOW()-INTERVAL '3 minutes',NOW()-INTERVAL '2 minutes','test_control_id',$1)",
    [JSON.stringify(activeMeta)],
  );
  await pg.query(
    "INSERT INTO call_sessions(id,user_id,to_phone_e164,provider,status,started_at,meta) VALUES(21,1,'+39060608','telnyx','started',NOW()-INTERVAL '4 minutes',$1)",
    [JSON.stringify(activeMeta)],
  );
  await watchdog.watchActiveCalls();
  assert.equal(stopped, 1);
  assert.ok(
    (await pg.query("SELECT meta FROM call_sessions WHERE id=20")).rows[0].meta
      .calling_budget_hangup_requested_at,
  );
  assert.equal(
    (await pg.query("SELECT status FROM call_sessions WHERE id=21")).rows[0]
      .status,
    "failed",
  );
  // A monitor failure pauses quotes and raises a persistent admin warning.
  await pg.query(
    "UPDATE voice_guard_settings SET monitor_error='test reporting outage' WHERE id=1",
  );
  assert.equal(
    (await guard.resolve("+39060608")).reason,
    "calling_guard_not_ready",
  );
  assert.ok(
    (await guard.health()).alerts.some((x) => x.alert_key === "readiness"),
  );
  fs.rmSync(temp, { recursive: true });
  await pg.close();
  console.log(
    "PASS: PostgreSQL migration, origin pricing, manual override, red loss block, review, CDR deduplication, real wallet debit / repeated webhook, ledger/refund audit, budget admission, global SDK-rate drift, and monitor-outage checks.",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
