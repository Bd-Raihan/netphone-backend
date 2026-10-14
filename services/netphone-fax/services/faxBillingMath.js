'use strict';
const {usdToMicro}=require('./faxMoney');
const money=v=>usdToMicro(v,true);
const markup=v=>(BigInt(v)*140n+99n)/100n;
function csv(text,maxRows=300000){
 if(typeof text!=='string'||Buffer.byteLength(text)>48*1024*1024)throw Error('CSV too large');
 const rows=[];let row=[],field='',quoted=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else if(!quoted&&field!=='')throw Error('Invalid CSV quoting');else quoted=!quoted;}
  else if(!quoted&&(c===','||c==='\n')){row.push(field.replace(/\r$/,''));field='';if(c==='\n'){if(row.some(x=>x!==''))rows.push(row);row=[];if(rows.length>maxRows+1)throw Error('Too many CSV records');}}
  else field+=c;
 }
 if(quoted)throw Error('Incomplete CSV');
 row.push(field.replace(/\r$/,''));if(row.some(x=>x!==''))rows.push(row);
 const header=(rows.shift()||[]).map(x=>x.replace(/^\uFEFF/,'').trim());
 if(!header.length||new Set(header).size!==header.length)throw Error('Invalid CSV header');
 return rows.map(r=>{if(r.length!==header.length)throw Error('CSV column count mismatch');return Object.fromEntries(header.map((k,i)=>[k,r[i]]));});
}
function get(row,...keys){const map=Object.fromEntries(Object.entries(row).map(([k,v])=>[k.toLowerCase().replace(/[^a-z0-9]/g,''),v]));for(const k of keys){const v=map[k.toLowerCase().replace(/[^a-z0-9]/g,'')];if(v!==undefined&&v!==null&&v!=='')return String(v);}return '';}
const phone=v=>String(v).replace(/^\+/, '');
function usage(row,kind){
 const cost=get(row,'cost');if(!cost)throw Error('Missing cost');
 const currency=get(row,'currency');if(kind==='fax'&&currency!=='USD')throw Error('USD Fax record required');if(currency&&currency!=='USD')throw Error('Non USD record');
 const session=get(row,'Telnyx call session id','Call UUID','call_session_id','call_session_uuid','telnyx_session_id');
 const key=kind==='fax'?get(row,'fax id','fax_id','fax_api_id','id'):get(row,'Unique CDR ID','uuid','id','call_leg_id');
 const direction=get(row,'direction');
 if(!/^[0-9a-f-]{36}$/i.test(session)||!key||!['inbound','outbound'].includes(direction))throw Error('Incomplete billing identity');
 const from=phone(get(row,'cli','Originating Number','originating_number','from'));
 const to=phone(get(row,'cld','Full Terminating number','Terminating number','destination_number','to'));
 if(!/^[1-9]\d{7,14}$/.test(from)||!/^[1-9]\d{7,14}$/.test(to))throw Error('Invalid billing numbers');
 return {kind,key,session,direction,from,to,cost:money(cost).toString(),connection:get(row,'connection id','Connection Id','connection_id'),fax_id:kind==='fax'?get(row,'fax id','fax_id','fax_api_id','id'):null};
}
function deckRow(row){
 const prefix=row['Destination Prefixes'];if(!/^[1-9][0-9X]{0,14}$/.test(prefix||''))throw Error('Invalid destination prefix');
 const first=Number(row['Interval 1']),next=Number(row['Interval N']);if(!Number.isInteger(first)||!Number.isInteger(next)||first<1||next<1||first>3600||next>3600)throw Error('Invalid intervals');
 if(!/^[A-Z]{2}(\/[A-Z]{2}){0,2}$/.test(row.ISO||''))throw Error('Invalid ISO');
 const origin=String(row['Origination Prefixes']||'').trim();if(origin&&origin!=='local'&&!origin.split(',').every(x=>/^[1-9]\d{0,14}$/.test(x.trim())))throw Error('Invalid origination prefix');
 return {prefix,origin,country:row.Country,iso:row.ISO,first,next,rate:money(row.Rate).toString(),per_call:money(row['Price Per Call']||'0').toString(),exact:String(row['Exact Match']||'').toUpperCase()==='YES'};
}
function select(rows,to,from){
 to=phone(to);from=phone(from);
 const matches=rows.filter(r=>new RegExp('^'+r.prefix.replace(/X/g,'[0-9]')+(r.exact?'$':'')).test(to));
 const eligible=matches.filter(r=>!r.origin||(r.origin!=='local'&&r.origin.split(',').some(p=>from.startsWith(p.trim()))));
 // 'local' is not inferred from destination ISO; provider routing decides local eligibility.
 eligible.sort((a,b)=>b.prefix.length-a.prefix.length||Number(Boolean(b.origin))-Number(Boolean(a.origin)));
 if(!eligible.length)throw Error('No verified Fax route');
 const first=eligible[0];const peers=eligible.filter(r=>r.prefix.length===first.prefix.length&&Boolean(r.origin)===Boolean(first.origin));
 if(peers.some(r=>r.rate!==first.rate||r.per_call!==first.per_call||r.first!==first.first||r.next!==first.next))throw Error('Ambiguous Fax route');
 return first;
}
function estimate(r,pages,secondsPerPage,api){
 if(!Number.isInteger(pages)||pages<1||pages>350)throw Error('Invalid pages');
 const duration=pages*secondsPerPage;
 const seconds=duration<=r.first?r.first:r.first+Math.ceil((duration-r.first)/r.next)*r.next;
 const sip=(BigInt(r.rate)*BigInt(seconds)+59n)/60n+BigInt(r.per_call);
 return markup(BigInt(api)*BigInt(pages)+sip);
}
module.exports={csv,get,usage,deckRow,select,estimate,markup,money,phone};
