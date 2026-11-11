"use strict";
const fs = require("fs");
const readline = require("readline");
const required = [
  "ISO",
  "Country",
  "Origination Prefixes",
  "Destination Prefixes",
  "Description",
  "Interval 1",
  "Interval N",
  "Rate",
  "Price Per Call",
  "Exact Match",
];
const digits = (v) => String(v || "").replace(/^\+/, "");
function micro(v) {
  const s = String(v ?? "").trim();
  if (!/^\d{1,8}(\.\d{1,6})?$/.test(s))
    throw Error("Invalid USD amount (up to six decimals)");
  const [w, f = ""] = s.split(".");
  return BigInt(w) * 1000000n + BigInt(f.padEnd(6, "0"));
}
function usd(v) {
  return Number(BigInt(v)) / 1000000;
}
function up(n, d) {
  return (BigInt(n) + BigInt(d) - 1n) / BigInt(d);
}
function markup(n, percent = 30) {
  const p = Number(percent);
  if (
    !Number.isFinite(p) ||
    p < 0 ||
    p > 1000 ||
    Math.abs(Math.round(p * 100) - p * 100) > 0.000001
  )
    throw Error("Invalid markup");
  return up(BigInt(n) * BigInt(10000 + Math.round(p * 100)), 10000n);
}
function csvLine(s) {
  let values = [],
    v = "",
    quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      if (quoted && s[i + 1] === '"') {
        v += '"';
        i++;
      } else if (!quoted && v) throw Error("Malformed CSV");
      else quoted = !quoted;
    } else if (c === "," && !quoted) {
      values.push(v);
      v = "";
    } else v += c;
  }
  if (quoted) throw Error("Unclosed CSV quote");
  values.push(v);
  return values;
}
function normalize(r) {
  const prefix = String(r["Destination Prefixes"] || "").trim();
  if (!/^[1-9][\dX]{0,14}$/.test(prefix))
    throw Error("Invalid destination prefix");
  const origin = String(r["Origination Prefixes"] || "").trim();
  if (
    origin &&
    origin !== "local" &&
    !origin.split(",").every((x) => /^[1-9]\d{0,14}$/.test(x.trim()))
  )
    throw Error("Invalid origin restriction");
  const iso = String(r.ISO || "").trim();
  if (!/^[A-Z]{2}(\/[A-Z]{2}){0,2}$/.test(iso))
    throw Error("Invalid country ISO");
  const first = Number(r["Interval 1"]),
    next = Number(r["Interval N"]);
  if (
    !Number.isInteger(first) ||
    first < 1 ||
    first > 3600 ||
    !Number.isInteger(next) ||
    next < 1 ||
    next > 3600
  )
    throw Error("Invalid billing intervals");
  const exactText = String(r["Exact Match"] || "")
    .trim()
    .toUpperCase();
  if (!["", "YES", "NO", "TRUE", "FALSE"].includes(exactText))
    throw Error("Invalid exact-match flag");
  return {
    prefix,
    fixed: prefix.match(/^\d+/)[0],
    origin,
    country: String(r.Country || "").trim(),
    iso,
    description: String(r.Description || "").trim(),
    first,
    next,
    rate: micro(r.Rate).toString(),
    fee: micro(r["Price Per Call"] || "0").toString(),
    exact: ["YES", "TRUE"].includes(exactText),
  };
}
async function readDeck(file, onBatch) {
  const stat = await fs.promises.stat(file);
  if (!stat.isFile() || stat.size > 48 * 1024 * 1024)
    throw Error("CSV must be under 48 MB");
  const stream = fs.createReadStream(file, { encoding: "utf8" }),
    lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null,
    batch = [],
    count = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const fields = csvLine(line);
      if (!header) {
        header = fields.map((x) => x.replace(/^\uFEFF/, "").trim());
        if (
          new Set(header).size !== header.length ||
          required.some((k) => !header.includes(k))
        )
          throw Error("Missing/duplicate CSV headers");
        continue;
      }
      if (fields.length !== header.length)
        throw Error("CSV column count mismatch at row " + (count + 2));
      batch.push(
        normalize(Object.fromEntries(header.map((k, i) => [k, fields[i]]))),
      );
      if (++count > 300000) throw Error("Too many CSV rows");
      if (batch.length === 1000) {
        await onBatch(batch, count - 1000);
        batch = [];
      }
    }
    if (batch.length) await onBatch(batch, count - batch.length);
    if (!count) throw Error("Empty CSV");
    return count;
  } finally {
    lines.close();
    stream.destroy();
  }
}
function originLength(r, from) {
  if (!r.origin) return 0;
  if (r.origin === "local") return -1;
  return Math.max(
    -1,
    ...r.origin
      .split(",")
      .map((x) => x.trim())
      .filter((x) => digits(from).startsWith(x))
      .map((x) => x.length),
  );
}
function select(rows, to, from) {
  const n = digits(to);
  if (
    !/^[1-9]\d{7,14}$/.test(n) ||
    !/^\+?[1-9]\d{7,14}$/.test(String(from || ""))
  )
    throw Error("Valid destination and provider Caller ID required");
  const match = rows.filter((r) =>
    new RegExp(
      "^" + r.prefix.replace(/X/g, "[0-9]") + (r.exact ? "$" : ""),
    ).test(n),
  );
  if (!match.length) throw Error("No matching CSV route");
  const applicable = match.filter((r) => originLength(r, from) >= 0);
  if (!applicable.length)
    throw Error("Origin restrictions require review for this route");
  const length = Math.max(...applicable.map((r) => r.prefix.length));
  const eligible = applicable.filter((r) => r.prefix.length === length);
  eligible.sort(
    (a, b) =>
      originLength(b, from) - originLength(a, from) ||
      Number(b.exact) - Number(a.exact),
  );
  const first = eligible[0];
  const peers = eligible.filter(
    (r) =>
      originLength(r, from) === originLength(first, from) &&
      r.exact === first.exact,
  );
  if (
    peers.some(
      (r) =>
        r.rate !== first.rate ||
        r.fee !== first.fee ||
        r.first !== first.first ||
        r.next !== first.next,
    )
  )
    throw Error("Ambiguous route costs; import/review required");
  return first;
}
function seconds(duration, first, next) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const d = Math.ceil(duration);
  return d <= first ? first : first + Math.ceil((d - first) / next) * next;
}
function fee(rate, duration) {
  const sec = seconds(duration, rate.first, rate.next);
  return sec ? up(BigInt(rate.rate) * BigInt(sec), 60n) + BigInt(rate.fee) : 0n;
}
function pricing(r, policy = {}, sdkMicro = 2000) {
  const cost = BigInt(r.rate) + BigInt(sdkMicro);
  const mode = policy.pricing_mode || "auto_markup";
  const percent = Number(policy.markup_percent ?? 30);
  const sell =
    mode === "manual_rate"
      ? micro(String(policy.manual_sell_rate_usd_per_min))
      : markup(cost, percent);
  return {
    cost,
    sell,
    safe: sell > cost,
    percent,
    mode,
    connection: mode === "manual_rate" ? BigInt(r.fee) : markup(r.fee, percent),
  };
}
function billUsage(r, policy, sdkMicro, duration) {
  const sipSeconds = seconds(duration, r.first, r.next),
    sdkSeconds = seconds(duration, 60, 60);
  const providerUsage =
    up(BigInt(r.rate) * BigInt(sipSeconds), 60n) +
    up(BigInt(sdkMicro) * BigInt(sdkSeconds), 60n);
  const customerSeconds = Math.max(sipSeconds, sdkSeconds);
  const sellUsage =
    policy.pricing_mode === "manual_rate"
      ? up(
          micro(String(policy.manual_sell_rate_usd_per_min)) *
            BigInt(customerSeconds),
          60n,
        )
      : markup(providerUsage, policy.markup_percent ?? 30);
  return { providerUsage, sellUsage, sipSeconds, sdkSeconds, customerSeconds };
}
function field(row, ...names) {
  const map = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.toLowerCase().replace(/[^a-z0-9]/g, ""),
      v,
    ]),
  );
  for (const name of names) {
    const v = map[name.toLowerCase().replace(/[^a-z0-9]/g, "")];
    if (v !== undefined && v !== null && v !== "") return String(v);
  }
  return "";
}
function cdr(row, kind) {
  const get = (...k) => field(row, ...k);
  const key = get("id", "Unique CDR ID", "uuid");
  const session = get(
    "telnyx_session_id",
    "call_session_id",
    "session_uuid",
    "Call UUID",
  );
  const connection = get("connection_id", "Connection Id");
  const currency = get("currency");
  if (currency && currency !== "USD") throw Error("Non-USD CDR");
  if (
    !key ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session) ||
    !connection
  )
    throw Error("Incomplete CDR identity");
  const to = digits(
      get("cld", "Full Terminating number", "destination_number", "to"),
    ),
    from = digits(
      get("cli", "Originating Number", "originating_number", "from"),
    );
  if (!/^[1-9]\d{7,14}$/.test(to) || !/^[1-9]\d{7,14}$/.test(from))
    throw Error("Invalid CDR numbers");
  const rawSeconds = get("billed_sec", "billed_seconds", "Billable time");
  const rate = get("rate");
  if (!/^\d+$/.test(rawSeconds) || !Number.isSafeInteger(Number(rawSeconds)))
    throw Error("Missing CDR billed seconds");
  return {
    kind,
    key,
    session,
    connection,
    to,
    from,
    cost: micro(get("cost")).toString(),
    seconds: Number(rawSeconds),
    rate: rate ? micro(rate).toString() : null,
    direction: get("direction"),
    leg: get(
      "call_leg_id",
      "telnyx_leg_id",
      "Telnyx call leg ID",
      "Unique CDR ID",
      "id",
      "uuid",
    ),
  };
}
module.exports = {
  billUsage,
  micro,
  usd,
  up,
  markup,
  csvLine,
  normalize,
  readDeck,
  originLength,
  select,
  seconds,
  fee,
  pricing,
  field,
  cdr,
  digits,
};
