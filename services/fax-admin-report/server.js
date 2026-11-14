'use strict';
const path=require('path');
// Read existing configuration only; never create/edit either .env.
require('dotenv').config({path:path.resolve(__dirname,'../netphone-fax/.env'),quiet:true});
require('dotenv').config({path:path.resolve(__dirname,'../../.env'),quiet:true});
const express=require('express');
const app=express();app.disable('x-powered-by');
app.use(express.json({limit:'4kb'}));
app.use('/api/fax/admin-report',require('./routes'));
app.get('/health',(req,res)=>res.json({ok:true,service:'fax-admin-report'}));
app.use((error,req,res,next)=>res.status(400).json({success:false,message:'Invalid report request'}));
const port=Number(process.env.FAX_ADMIN_REPORT_PORT||8790);
app.listen(port,'127.0.0.1',()=>console.log(`Fax Admin Report listening on 127.0.0.1:${port}`));
