'use strict';
const fail=(m,status=400)=>Object.assign(new Error(m),{status});
function filters(q={}){
 const search=String(q.search||'').trim();if(search.length>100)throw fail('Search is too long');
 const offset=Number(q.offset||0);if(!Number.isSafeInteger(offset)||offset<0||offset>1000000)throw fail('Invalid offset');
 const dates=['from','to'].map(k=>{if(!q[k])return null;const s=String(q[k]);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)throw fail('Invalid date');return s;});
 if(dates[0]&&dates[1]&&dates[0]>dates[1])throw fail('Start date must precede end date');
 const direction=String(q.direction||'');if(!['','inbound','outbound'].includes(direction))throw fail('Invalid direction');
 const bin=String(q.bin||'active');if(!['active','trash','all'].includes(bin))throw fail('Invalid list');
 return {offset,params:[dates[0],dates[1],'%'+search.replace(/[\\%_]/g,'\\$&')+'%',direction,bin],search};
}
const BASE=`WITH selected AS (
 SELECT f.*,to_jsonb(u) AS owner,b.pages AS billing_pages,b.state AS billing_state,
 b.amount_microusd,b.provider_cost_microusd,b.actual_settled,b.rate_snapshot,b.billing_details,
 COALESCE(v.archived,FALSE) AS admin_archived,v.reason AS archive_reason,
 b.charged_tx_id,b.refunded_tx_id
 FROM netphone_faxes f LEFT JOIN users u ON u.id=f.user_id
 LEFT JOIN netphone_fax_billing b ON b.fax_id=f.id
 LEFT JOIN netphone_fax_admin_visibility v ON v.fax_id=f.id
 WHERE ($1::date IS NULL OR f.created_at >= $1::date::timestamp AT TIME ZONE 'UTC')
 AND ($2::date IS NULL OR f.created_at < ($2::date+1)::timestamp AT TIME ZONE 'UTC')
 AND (f.id::text ILIKE $3 OR f.from_number ILIKE $3 OR f.to_number ILIKE $3
 OR u.phone_e164 ILIKE $3 OR COALESCE(to_jsonb(u)->>'name',to_jsonb(u)->>'full_name','') ILIKE $3)
 AND ($4='' OR f.direction=$4)
 AND ($5='all' OR COALESCE(v.archived,FALSE)=($5='trash'))
), report AS (
 SELECT s.*,COALESCE(w.charged,0)::text AS charged_micro,COALESCE(w.refunded,0)::text AS refunded_micro,
 (COALESCE(w.charged,0)-COALESCE(w.refunded,0))::text AS net_micro,
 (s.actual_settled IS TRUE AND s.provider_cost_microusd IS NOT NULL) AS cost_verified
 FROM selected s LEFT JOIN LATERAL (
 SELECT SUM(t.amount_microusd) FILTER(WHERE t.type='fax_charge') AS charged,
 SUM(t.amount_microusd) FILTER(WHERE t.type='fax_refund') AS refunded
 FROM wallet_transactions t WHERE t.status='posted' AND t.type IN ('fax_charge','fax_refund')
 AND (t.meta->>'fax_id'=s.id::text OR t.id=s.charged_tx_id OR t.id=s.refunded_tx_id)
 ) w ON TRUE
)`;
// String amounts preserve micro-dollar accuracy all the way to export.
const amount=(v,scale=6)=>{if(v==null)return null;const n=BigInt(v),a=n<0n?-n:n;return (n<0n?'-':'')+(a/(10n**BigInt(scale)))+'.'+(a%(10n**BigInt(scale))).toString().padStart(scale,'0');};
function row(r,country=()=>null){
 const net=BigInt(r.net_micro||0),verified=r.cost_verified===true;
 const pages=Number(r.billing_details?.delivered_pages??r.pages??r.billing_pages??0);
 const owner=r.owner||{};
 const name=owner.name||owner.full_name||null;
 return {id:String(r.id),date:r.created_at,direction:r.direction,status:r.status,
 failure_reason:r.failure_reason||null,owner_mobile:owner.phone_e164||null,owner_name:name,
 sender_mobile:r.from_number,receiver_mobile:r.to_number,
 sender_name:r.direction==='outbound'?name:null,
 country_send:country(r.from_number),country_receive:country(r.to_number),
 pages,requested_pages:Number(r.billing_pages||r.pages||0),
 provider_cost:amount(r.provider_cost_microusd),vat:null,provider_cost_plus_vat:null,
 api_cost:r.billing_details?.api_cost_usd??null,sip_cost:r.billing_details?.sip_cost_usd??null,
 billed_seconds:r.billing_details?.billed_seconds??null,
 per_page_cost:pages>0?amount(net*1000n/BigInt(pages),9):null,
 charged:amount(r.charged_micro||0),refund:amount(r.refunded_micro||0),
 send_cost:amount(r.direction==='outbound'?net:0),receive_cost:amount(r.direction==='inbound'?net:0),total_cost:amount(net),
 profit:verified?amount(net-BigInt(r.provider_cost_microusd)):null,
 cost_status:verified?'Verified provider cost; VAT unavailable':'Pending provider cost',
 billing_state:r.billing_state||'unbilled',archived:r.admin_archived===true,archive_reason:r.archive_reason||null};
}
function totals(r){return {count:Number(r.count),pages:Number(r.pages),pending:Number(r.pending),
 send_cost:amount(r.send),receive_cost:amount(r.receive),total_cost:amount(r.net),charged:amount(r.charged),refund:amount(r.refunded),
 verified_provider_cost:amount(r.provider),verified_profit:amount(r.profit),vat:null,
 provider_cost_plus_vat:null};}
async function list(client,q,country){
 const f=filters(q);
 const sums=(await client.query(BASE+` SELECT COUNT(*)::text AS count,COALESCE(SUM(COALESCE((billing_details->>'delivered_pages')::integer,pages,billing_pages,0)),0)::text AS pages,
 COUNT(*) FILTER(WHERE NOT cost_verified)::text AS pending,
 COALESCE(SUM(net_micro::numeric) FILTER(WHERE direction='outbound'),0)::text AS send,
 COALESCE(SUM(net_micro::numeric) FILTER(WHERE direction='inbound'),0)::text AS receive,
 COALESCE(SUM(net_micro::numeric),0)::text AS net,COALESCE(SUM(charged_micro::numeric),0)::text AS charged,
 COALESCE(SUM(refunded_micro::numeric),0)::text AS refunded,
 COALESCE(SUM(provider_cost_microusd) FILTER(WHERE cost_verified),0)::text AS provider,
 COALESCE(SUM(net_micro::numeric-provider_cost_microusd) FILTER(WHERE cost_verified),0)::text AS profit FROM report`,f.params)).rows[0];
 const exporting=q.export==='true';
 if(exporting&&Number(sums.count)>5000)throw fail('Select a smaller date range for PDF export (maximum 5,000 faxes).',422);
 const limit=exporting?5000:50;
 const rows=(await client.query(BASE+' SELECT * FROM report ORDER BY created_at DESC,id DESC LIMIT $6 OFFSET $7',[...f.params,limit+1,exporting?0:f.offset])).rows;
 return {rows:rows.slice(0,limit).map(r=>row(r,country)),more:rows.length>limit,totals:totals(sums),timezone:'UTC',
 note:'Wallet net = posted Fax charges minus posted refunds. Profit shown before unreported VAT. Pending costs excluded from verified totals. Archive affects this admin list only.'};
}
async function visibility(client,id,actor,archived,reason){
 if(!/^\d+$/.test(String(id))||BigInt(id)<1n||BigInt(id)>9223372036854775807n)throw fail('Invalid Fax ID');
 reason=String(reason||'').trim();if(reason.length<3||reason.length>300)throw fail('Enter a reason (3–300 characters)');
 // No locks or writes on source Fax / wallet / document tables.
 const exists=(await client.query('SELECT id FROM netphone_faxes WHERE id=$1',[id])).rows[0];if(!exists)throw fail('Fax not found',404);
 await client.query(`INSERT INTO netphone_fax_admin_visibility(fax_id,archived,actor_user_id,reason)
 VALUES($1,$2,$3,$4) ON CONFLICT(fax_id) DO UPDATE SET archived=EXCLUDED.archived,
 actor_user_id=EXCLUDED.actor_user_id,reason=EXCLUDED.reason,updated_at=NOW()`,[id,archived,actor,reason]);
 await client.query('INSERT INTO netphone_fax_admin_report_audit(fax_id,actor_user_id,action,reason) VALUES($1,$2,$3,$4)',[id,actor,archived?'archive':'restore',reason]);
 return {archived};
}
module.exports={filters,BASE,row,amount,list,visibility};
