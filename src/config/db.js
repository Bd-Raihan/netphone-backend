/**
 * db.js
 * কাজ:
 * - PostgreSQL এর সাথে কানেকশন তৈরি করা (Pool)
 * - .env থেকে settings নেয়া
 */

const { Pool } = require("pg");

// .env থেকে DB config নেয়া
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 10, // একসাথে সর্বোচ্চ 10 কানেকশন
  idleTimeoutMillis: 30000,
});

// ছোট helper: query চালানোর জন্য
async function query(text, params) {
  return pool.query(text, params);
}

// ✅ নতুন helper: transaction / FOR UPDATE এর জন্য client দরকার হবে
async function getClient() {
  return pool.connect();
}

module.exports = {
  pool,
  query,
  getClient, // ✅ add
};
