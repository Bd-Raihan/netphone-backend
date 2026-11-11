"use strict";
const guard=require('../calling-guard/guard.service');
const m=require('../calling-guard/money-routes');
// Viewing prices never enables calling or changes policies. Disabled/blocked routes stay unavailable.
async function getPublicRates(){
 const rows=await guard.countries();
 return rows.map(x=>({country_name:x.country_name,country_code:x.country_code,prefix:x.prefix,
 sell_rate_usd_per_min:x.final_sell_rate_usd_per_min,sell_max_usd_per_min:x.sell_max_usd_per_min,
 price_per_min_cents:Math.ceil(x.final_sell_rate_usd_per_min*100),rate_is_range:x.final_sell_rate_usd_per_min!==x.sell_max_usd_per_min,
 calling_available:!!(x.guard_enabled&&x.is_active&&x.publish_rate&&x.guard_ready),
 availability_message:!x.is_active?'Calling unavailable':x.has_loss?'Calling unavailable — rate review required':!x.guard_enabled||!x.guard_ready?'Preview — calling currently unavailable':'Calling available',
 updated_at:x.updated_at}));
}
async function getPublicRateByPhone(phone){
 const s=await guard.settings();
 // A preview uses the same CSV selection and policy maths, without bypassing call admission.
 if(!s.deck_version)return null;
 const r=await guard.selectRoute(phone,s);
 const p=await guard.policy(phone,r.iso.split('/')[0]);
 const pricing=guard.prices(r,p,s);
 if(!pricing.safe)return null;
 const allowed=s.enabled ? await guard.resolve(phone,s) : {ok:false};
 return {country_name:r.country,country_code:r.iso.split('/')[0],prefix:r.prefix,
 sell_rate_usd_per_min:m.usd(pricing.sell),
 price_per_min_cents:Math.ceil(m.usd(pricing.sell)*100),
 billing_increment_seconds:r.next,minimum_duration_seconds:r.first,
 connection_fee_usd:m.usd(pricing.connection),
 calling_available:!!allowed.ok,availability_message:allowed.ok?'Calling available':'Preview — calling currently unavailable'};
}
function clearPublicRatesCache(){}
module.exports={getPublicRates,getPublicRateByPhone,clearPublicRatesCache};
