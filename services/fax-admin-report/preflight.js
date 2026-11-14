'use strict';
const path=require('path');
require('dotenv').config({path:path.resolve(__dirname,'../netphone-fax/.env'),quiet:true});
require('dotenv').config({path:path.resolve(__dirname,'../../.env'),quiet:true});
const {Client}=require('pg');
(async()=>{
 const c=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),database:process.env.DB_NAME,
 user:process.env.DB_USER,password:process.env.DB_PASSWORD,connectionTimeoutMillis:3000,query_timeout:7000});
 await c.connect();try{
 await c.query('BEGIN READ ONLY');await c.query("SET LOCAL statement_timeout='5s'");
 const r=await c.query(`SELECT current_database() AS database,
 (SELECT COUNT(*)::text FROM netphone_faxes) AS faxes,
 (SELECT COUNT(*)::text FROM netphone_fax_billing) AS fax_bills,
 (SELECT COUNT(*)::text FROM users) AS accounts,
 (SELECT COUNT(*)::text FROM wallets) AS wallets,
 (SELECT COUNT(*)::text FROM wallet_transactions) AS wallet_entries,
 (SELECT COUNT(*)::text FROM netphone_faxes WHERE status NOT IN ('delivered','received','failed')) AS nonterminal_faxes`);
 console.log(JSON.stringify(r.rows[0],null,2));
 console.log('Read-only check complete. No existing service was stopped or changed.');
 await c.query('COMMIT');
 }finally{await c.end();}
})().catch(e=>{console.error(e.code||'PRECHECK_FAILED',e.message);process.exitCode=1;});
