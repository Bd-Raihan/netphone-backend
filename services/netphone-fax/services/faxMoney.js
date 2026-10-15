"use strict";

function usdToMicro(value, allowZero = false) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,6}(\.\d{1,6})?$/.test(text)) throw new Error("Enter USD with at most 6 decimal places.");
  const [whole, fraction = ""] = text.split(".");
  const amount = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  if ((!allowZero && amount <= 0n) || amount > 100000000000n) throw new Error("Invalid USD amount.");
  return amount;
}
function microToUsd(value) {
  const amount = BigInt(value);
  return `${amount / 1000000n}.${(amount % 1000000n).toString().padStart(6, "0")}`;
}
function sellRate(rate) {
  const cost = BigInt(rate.provider_cost_microusd_per_page);
  if (cost <= 0n) throw new Error("Provider cost is not configured.");
  // Use the saved rate version; legacy snapshots retain 40%. Round upward to micro-USD.
  return (cost * BigInt(10000 + (rate.markup_percent ?? 40) * 100) + 9999n) / 10000n;
}
function matchRate(rates, phone, direction) {
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error("Use an international fax number.");
  const digits = phone.slice(1);
  const matches = rates.filter(r => r.direction === direction && digits.startsWith(r.phone_prefix))
    .sort((a,b) => b.phone_prefix.length - a.phone_prefix.length);
  const rate = matches[0];
  // A disabled specific route must not fall back to a cheaper broad prefix.
  if (!rate || !rate.is_active || !rate.cost_confirmed) throw new Error("Fax pricing is unavailable for this number.");
  return rate;
}
function feeForPages(rate, pages) {
  if (!Number.isInteger(pages) || pages < 1 || pages > 350) throw new Error("Invalid fax page count.");
  return sellRate(rate) * BigInt(pages);
}
module.exports = {usdToMicro, microToUsd, sellRate, matchRate, feeForPages};
