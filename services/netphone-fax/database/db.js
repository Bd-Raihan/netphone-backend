/**
 * NetPhone Fax - Database Connection
 * Independent Fax Service
 */

require("dotenv").config();

const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

async function query(text, params) {
  return pool.query(text, params);
}

async function getClient() {
  return pool.connect();
}

async function testConnection() {
  const result = await pool.query(
    "SELECT current_database() AS database_name"
  );

  console.log(
    "Fax Database Connected:",
    result.rows[0].database_name
  );
}

module.exports = {
  pool,
  query,
  getClient,
  testConnection,
};