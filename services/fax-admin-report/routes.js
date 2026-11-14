'use strict';
const express=require('express');
const jwt=require('jsonwebtoken');
const {Pool}=require('pg');
let parsePhoneNumberFromString=()=>null;
try {({parsePhoneNumberFromString}=require('libphonenumber-js'));}catch(_){}
const report=require('./report');
// This pool is deliberately independent from the five Fax worker connections.
let pool;
function connectionPool(){if(pool)return pool;pool=new Pool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),
 database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
 max:2,connectionTimeoutMillis:1500,idleTimeoutMillis:10000,query_timeout:7000,
 application_name:'netphone-fax-admin-report'});pool.on('error',()=>{});return pool;}
let active=0;
const router=express.Router();
function country(number){try {const iso=parsePhoneNumberFromString(String(number||''))?.country;
 return iso?new Intl.DisplayNames(['en'],{type:'region'}).of(iso):null;}catch(_){return null;}}
function endpoint(write,fn){return async(req,res)=>{
 res.set({'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'});
 let decoded;
 try{const token=(req.headers.authorization||'').match(/^Bearer (.+)$/)?.[1];
 if(!token||!process.env.JWT_ACCESS_SECRET)throw Error();decoded=jwt.verify(token,process.env.JWT_ACCESS_SECRET);
 if(!Number.isSafeInteger(Number(decoded.userId))||Number(decoded.userId)<1)throw Error();
 }catch(_){return res.status(401).json({success:false,message:'Authentication required'});}
 if(active>=2)return res.status(503).json({success:false,message:'Fax report busy. Retry shortly.'});
 active++;let c;
 try{
 c=await connectionPool().connect();await c.query(write?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 await c.query("SET LOCAL statement_timeout='5s'");await c.query("SET LOCAL lock_timeout='500ms'");
 const user=(await c.query('SELECT id,role,status FROM users WHERE id=$1',[decoded.userId])).rows[0];
 if(!user||user.status!=='active'||user.role!=='admin')throw Object.assign(Error('Admin access required'),{status:403});
 const result=await fn(c,req,user);await c.query('COMMIT');res.json({success:true,...result});
 }catch(e){if(c)try{await c.query('ROLLBACK');}catch(_){}
 res.status(e.status||503).json({success:false,message:e.status?e.message:'Fax report temporarily unavailable. Existing fax processing continues.'});
 }finally{if(c)c.release();active--;}
};}
router.get('/',endpoint(false,(c,req)=>report.list(c,req.query,country)));
router.post('/:faxId/archive',endpoint(true,(c,req,u)=>report.visibility(c,req.params.faxId,u.id,true,req.body.reason)));
router.post('/:faxId/restore',endpoint(true,(c,req,u)=>report.visibility(c,req.params.faxId,u.id,false,req.body.reason)));
router.get('/audit',endpoint(false,async(c,req)=>{
 const {offset}=report.filters(req.query);
 const r=await c.query(`SELECT a.*,u.phone_e164 AS actor_mobile FROM netphone_fax_admin_report_audit a
 LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.id DESC LIMIT 51 OFFSET $1`,[offset]);
 return {rows:r.rows.slice(0,50),more:r.rows.length>50};
}));
module.exports=router;
