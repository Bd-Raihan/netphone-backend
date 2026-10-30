'use strict';
require('dotenv').config({quiet:true});
const db=require('../database/db');
const provider=require('../services/personalFaxProvider');
async function main() {
  const mode=process.argv[2];
  if(mode==='--create-application') {
    const base=new URL(process.env.FAX_PUBLIC_BASE_URL||'');
    if(base.protocol!=='https:'||!process.env.TELNYX_PUBLIC_KEY)throw Error('Set FAX_PUBLIC_BASE_URL (HTTPS) and TELNYX_PUBLIC_KEY first.');
    const webhook=base.toString().replace(/\/$/,'')+'/api/fax/personal-numbers/webhook';
    const matches=[];
    for(let page=1;page<=10;page++) {
      const r=await provider.api('GET','/fax_applications',undefined,{'page[number]':page,'page[size]':100});
      if(!Array.isArray(r.data)||!Number.isInteger(r.meta?.total_pages))throw Error('Cannot verify existing Fax Applications; inspect the portal first.');
      matches.push(...r.data.filter(a=>a.application_name==='NetPhone Personal Fax'));
      if(page>=r.meta.total_pages)break;
      if(page===10)throw Error('Too many applications; inspect the portal first.');
    }
    if(matches.length>1)throw Error('Multiple Personal Fax Applications found. Select the correct one manually.');
    let app=matches[0];
    if(app && (app.webhook_event_url!==webhook||app.active!==true))throw Error('An application with this name already exists with different settings. Inspect it; existing settings were not changed.');
    if(!app)app=(await provider.api('POST','/fax_applications',{application_name:'NetPhone Personal Fax',active:true,webhook_event_url:webhook,tags:['netphone-personal-fax']})).data;
    if(!/^\d+$/.test(String(app?.id||'')))throw Error('Creation result is unclear. Inspect Telnyx before retrying.');
    if(String(app.id)===String(process.env.TELNYX_FAX_CONNECTION_ID))throw Error('Shared application cannot be used for personal numbers.');
    console.log('Personal Fax Application ready. Add to this service .env:');
    console.log('TELNYX_PERSONAL_FAX_CONNECTION_ID='+String(app.id));
    console.log('PERSONAL_FAX_PURCHASE_ENABLED=false');
    console.log('Webhook: '+webhook);
    console.log('This command did not buy, release or alter any phone number.');
    return;
  }
  if(mode==='--review') {
    const r=await db.query(`SELECT id,user_id,phone_number,state,review_reason,paid_until FROM netphone_personal_fax_numbers
      WHERE review_reason IS NOT NULL OR state='release_pending' ORDER BY updated_at DESC LIMIT 100`);
    console.table(r.rows);
    const events=await db.query(`SELECT fax_id,attempts,review_reason,created_at FROM netphone_personal_fax_events
      WHERE completed_at IS NULL AND attempts>2 ORDER BY created_at LIMIT 100`);
    console.table(events.rows);return;
  }
  if(mode!=='--check')throw Error('Use --check (read only), --review (read only), or --create-application (creates a new independent Fax Application).');
  await provider.ready();
  const result=await db.query(`SELECT
    (has_table_privilege(current_user,'netphone_personal_fax_numbers','SELECT') AND has_table_privilege(current_user,'netphone_personal_fax_numbers','INSERT') AND has_table_privilege(current_user,'netphone_personal_fax_numbers','UPDATE')) AS numbers,
    (has_table_privilege(current_user,'netphone_personal_fax_periods','SELECT') AND has_table_privilege(current_user,'netphone_personal_fax_periods','INSERT') AND has_table_privilege(current_user,'netphone_personal_fax_periods','UPDATE')) AS periods,
    (has_table_privilege(current_user,'netphone_personal_fax_events','SELECT') AND has_table_privilege(current_user,'netphone_personal_fax_events','INSERT') AND has_table_privilege(current_user,'netphone_personal_fax_events','UPDATE')) AS events,
    (has_table_privilege(current_user,'netphone_personal_fax_audit','SELECT') AND has_table_privilege(current_user,'netphone_personal_fax_audit','INSERT')) AS audit,
    has_sequence_privilege(current_user,'netphone_personal_fax_audit_id_seq','USAGE') AS sequence,
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='netphone_faxes' AND column_name='provider_connection_id') AS fax_column`);
  if(Object.values(result.rows[0]).some(v=>v!==true))throw Error('Database setup/permissions are incomplete. Run migration as postgres.');
  console.log('Personal Fax Application, webhook, database and runtime permissions OK.');
  console.log('Purchase switch: '+(process.env.PERSONAL_FAX_PURCHASE_ENABLED==='true'?'ON':'OFF'));
  console.log('No purchase/release request was made. Mobile and real Telnyx end-to-end tests are still required.');
}
main().catch(e=>{console.error(e.response?'Provider request failed (HTTP '+e.response.status+'). Check Telnyx and permissions; do not repeat a purchase blindly.':e.message);process.exitCode=1;}).finally(()=>db.pool.end());
