'use strict';
const fail=(m,s=400)=>Object.assign(new Error(m),{status:s});
function faxId(req){const n=Number(req.params.faxId);if(!Number.isSafeInteger(n)||n<1)throw fail('Fax not found',404);return n;}
async function archive(req,transaction,audit){
 const id=faxId(req),reason=String(req.body.reason||'').trim();
 if(reason.length<3||reason.length>300)throw fail('Enter a reason (3–300 characters)');
 return transaction(async c=>{
  const f=(await c.query(`SELECT f.* FROM netphone_faxes f JOIN netphone_fax_incoming i ON i.fax_id=f.id WHERE f.id=$1 FOR UPDATE OF f`,[id])).rows[0];
  if(!f)throw fail('Incoming fax not found',404);
  if(f.user_id!=null)throw fail('Assigned documents cannot be removed from a user account',409);
  const row=(await c.query(`INSERT INTO netphone_fax_inbox_archives(fax_id,archived_by,reason) VALUES($1,$2,$3)
   ON CONFLICT(fax_id) DO NOTHING RETURNING fax_id`,[id,req.user.id,reason])).rows[0];
  if(row)await audit(c,req.user.id,'incoming_archived',id,{file_name:f.file_name||`Fax_${id}.pdf`,from_number:f.from_number,reason});
  return {archived:true};
 });
}
async function restore(req,transaction,audit){
 const id=faxId(req);
 return transaction(async c=>{
  const f=(await c.query('SELECT id,user_id FROM netphone_faxes WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!f)throw fail('Fax not found',404);
  if(f.user_id!=null)throw fail('Fax already assigned',409);
  const row=(await c.query('DELETE FROM netphone_fax_inbox_archives WHERE fax_id=$1 RETURNING fax_id',[id])).rows[0];
  if(row)await audit(c,req.user.id,'incoming_restored',id,{});
  return {restored:true};
 });
}
async function history(req,db){
 const offset=Number(req.query.offset||0);if(!Number.isSafeInteger(offset)||offset<0||offset>300000)throw fail('Invalid history offset');
 const rows=(await db.query(`SELECT a.fax_id,a.action,a.created_at,a.actor_user_id,a.details,
 u.phone_e164 AS actor_phone,EXISTS(SELECT 1 FROM netphone_fax_inbox_archives x WHERE x.fax_id=a.fax_id) AS archived
 FROM netphone_fax_audit a LEFT JOIN users u ON u.id=a.actor_user_id
 WHERE a.action IN ('incoming_archived','incoming_restored') ORDER BY a.created_at DESC,a.fax_id DESC LIMIT 51 OFFSET $1`,[offset])).rows;
 return {history:rows.slice(0,50),more:rows.length>50};
}
function install(router,admin,endpoint,db,transaction,audit){
 router.get('/admin/inbox/history',...admin,endpoint(req=>history(req,db)));
 router.post('/admin/inbox/:faxId/archive',...admin,endpoint(req=>archive(req,transaction,audit)));
 router.post('/admin/inbox/:faxId/restore',...admin,endpoint(req=>restore(req,transaction,audit)));
}
module.exports={install,archive,restore,history};
