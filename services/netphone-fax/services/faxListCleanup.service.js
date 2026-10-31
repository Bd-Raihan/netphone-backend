'use strict';
const fail=(m,status=400)=>Object.assign(new Error(m),{status});
function positive(value){const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw fail('Record not found',404);return n;}
async function remove(req,db,kind){
 const user=positive(req.user?.id),id=positive(req.params.itemId);
 // Fixed identifiers only, never interpolated user input.
 const fax=kind==='fax',table=fax?'netphone_faxes':'netphone_fax_notifications';
 const hides=fax?'netphone_fax_history_hides':'netphone_fax_notification_hides';
 const column=fax?'fax_id':'notification_id';
 const row=(await db.query(`SELECT id${fax?',status':''} FROM ${table} WHERE id=$1 AND user_id=$2`,[id,user])).rows[0];
 if(!row)throw fail('Record not found',404);
 if(fax&&!['received','delivered','failed'].includes(String(row.status).toLowerCase()))
  throw fail('This fax is still processing. Wait for its final status before deleting it from History.',409);
 await db.query(`INSERT INTO ${hides}(user_id,${column}) VALUES($1,$2) ON CONFLICT(user_id,${column}) DO NOTHING`,[user,id]);
 return {deleted:true};
}
function endpoint(fn){return async(req,res)=>{try{res.json({success:true,...await fn(req)});}catch(e){console.error('Fax list cleanup:',e.status||'database_error');res.status(e.status||500).json({success:false,message:e.status?e.message:'Unable to delete this item. Please try again.'});}};}
function installFax(router,auth,db){router.delete('/history/:itemId',auth,endpoint(req=>remove(req,db,'fax')));}
function installNotifications(router,auth,db){router.delete('/:itemId',auth,endpoint(req=>remove(req,db,'notification')));}
module.exports={installFax,installNotifications,remove};
