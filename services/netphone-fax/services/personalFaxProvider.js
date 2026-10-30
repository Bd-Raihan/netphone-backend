'use strict';
const axios=require('axios');
const {fail}=require('./personalFaxPolicy');
function config() {
  const key=process.env.TELNYX_FAX_API_KEY;
  const connection=String(process.env.TELNYX_PERSONAL_FAX_CONNECTION_ID||'').trim();
  const publicKey=process.env.TELNYX_PUBLIC_KEY;
  const url=new URL(process.env.FAX_PUBLIC_BASE_URL||'https://invalid.invalid');
  if(!key||!/^\d+$/.test(connection)||connection===String(process.env.TELNYX_FAX_CONNECTION_ID)||Buffer.from(publicKey||'','base64').length!==32||url.protocol!=='https:'||url.hostname==='invalid.invalid')
    throw fail('Personal fax number setup is not ready',503);
  return {key,connection,webhook:`${url.toString().replace(/\/$/,'')}/api/fax/personal-numbers/webhook`};
}
async function api(method,path,data,params) {
  const key=process.env.TELNYX_FAX_API_KEY;if(!key)throw fail('Fax provider configuration is unavailable',503);
  const r=await axios({method,url:'https://api.telnyx.com/v2'+path,data,params,
    headers:{Authorization:`Bearer ${key}`,Accept:'application/json'},timeout:12000,maxRedirects:0,
    maxContentLength:4*1024*1024,proxy:false});
  return r.data;
}
let checkedUntil=0,checkedConnection='';
async function ready() {
  const c=config();
  if(Date.now()<checkedUntil&&checkedConnection===c.connection)return c;
  const app=(await api('GET','/fax_applications/'+encodeURIComponent(c.connection))).data;
  if(app?.active!==true||app.webhook_event_url!==c.webhook)throw fail('Personal fax receiving configuration needs review',503);
  checkedUntil=Date.now()+60000;checkedConnection=c.connection;return c;
}
async function available(phone) {
  const params={'filter[country_code]':'US','filter[phone_number_type]':'local','filter[features][]':'fax',
    'filter[quickship]':true,'filter[best_effort]':false,'filter[limit]':phone?10:20};
  if(phone)params['filter[phone_number][contains]']=phone.replace(/^\+/,'');
  try {return (await api('GET','/available_phone_numbers',undefined,params)).data||[];}
  catch(e){if(e.response?.status===400&&e.response.data?.errors?.some(x=>String(x.code)==='10031'))return [];throw e;}
}
async function lookup(phone) {
  const rows=(await api('GET','/phone_numbers',undefined,{'filter[phone_number]':phone.replace(/^\+/,''),'page[size]':100})).data||[];
  const match=rows.filter(r=>r.phone_number===phone);if(match.length>1)throw fail('Number identity needs review',503);
  return match[0]||null;
}
async function orders(reference) {
  const rows=(await api('GET','/number_orders',undefined,{'filter[customer_reference]':reference,'page[size]':100})).data||[];
  return rows.filter(r=>r.customer_reference===reference);
}
module.exports={api,config,ready,available,lookup,orders};
