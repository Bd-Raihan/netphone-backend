"use strict";
const fs = require("fs");
const path = require("path");
require("dotenv").config({path:path.resolve(__dirname,"../.env")});
const db = require("../database/db");
(async () => {
  const client = await db.getClient();
  try {
    const result = await client.query(`SELECT current_database() AS database_name,current_user AS database_role,
      has_schema_privilege(current_user,'public','CREATE') AS can_create_tables,
      (has_table_privilege(current_user,'public.users','SELECT') AND has_table_privilege(current_user,'public.users','REFERENCES')) AS users_access,
      (has_table_privilege(current_user,'public.wallets','SELECT') AND has_table_privilege(current_user,'public.wallets','UPDATE')) AS wallets_access,
      (has_table_privilege(current_user,'public.wallet_transactions','SELECT') AND has_table_privilege(current_user,'public.wallet_transactions','INSERT')
        AND has_table_privilege(current_user,'public.wallet_transactions','REFERENCES')) AS transactions_access,
      has_sequence_privilege(current_user,pg_get_serial_sequence('public.wallet_transactions','id'),'USAGE') AS transaction_sequence_access,
      (has_table_privilege(current_user,'public.netphone_faxes','SELECT') AND has_table_privilege(current_user,'public.netphone_faxes','INSERT')
        AND has_table_privilege(current_user,'public.netphone_faxes','UPDATE') AND has_table_privilege(current_user,'public.netphone_faxes','REFERENCES')) AS fax_access,
      (has_table_privilege(current_user,'public.netphone_fax_uploads','SELECT') AND has_table_privilege(current_user,'public.netphone_fax_uploads','UPDATE')
        AND has_table_privilege(current_user,'public.netphone_fax_uploads','REFERENCES')) AS uploads_access`);
    console.log(JSON.stringify(result.rows[0],null,2));
    if (!process.argv.includes("--apply")) return;
    const expected = process.argv.find(arg=>arg.startsWith("--database="))?.slice(11);
    if (!expected || expected !== result.rows[0].database_name) throw new Error("Specify the intended database with --database=NAME");
    if (Object.entries(result.rows[0]).some(([key,value])=>key.endsWith("_access") || key==="can_create_tables" ? value!==true : false))
      throw new Error("Required database permissions are missing. No migration was applied.");
    const sql = fs.readFileSync(path.resolve(__dirname,"../../../database/migrations/032_fax_rates_billing_private_inbox.sql"),"utf8");
    await client.query(sql);
    console.log("Fax tables created. Charging remains OFF.");
  } finally {client.release(); await db.pool.end();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
