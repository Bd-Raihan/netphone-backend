/**
 * server.js
 * ----------------
 * এই ফাইলের কাজ:
 * - .env ফাইল লোড করা
 * - Express app চালু করা
 * - Server কোন PORT এ রান করবে সেট করা
 */

require("dotenv").config(); // .env ফাইল লোড

const app = require("./app");

// PORT .env থেকে নেওয়া
const PORT = process.env.PORT || 8080;

// Server চালু
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 AlHawari Call API running on port ${PORT}`);
});
