"use strict";
// Retired: reporting history must never disappear through a reset action.
async function start() {
  throw Object.assign(new Error('Report reset is disabled. Existing history is retained.'), {statusCode:410});
}
module.exports = {start};
