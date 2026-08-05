"use strict";

const routes = require(
  "./payment.routes"
);

const controller = require(
  "./payment.controller"
);

const orderService = require(
  "./payment.order.service"
);

const repository = require(
  "./payment.repository"
);

const historyService = require(
  "./payment.history.service"
);

const reconciliationRepository = require(
  "./payment.reconciliation.repository"
);

const providers = require(
  "./providers"
);

const constants = require(
  "./payment.constants"
);

/**
 * NetPhone Payment Engine module entry point.
 *
 * app.js শুধু routes ব্যবহার করবে।
 * অন্য internal module প্রয়োজন হলে এখান থেকে
 * service/repository access করতে পারবে।
 */
module.exports = {
  routes,

  controller,

  services: {
    order:
      orderService,

    history:
      historyService,
  },

  repositories: {
    payment:
      repository,

    reconciliation:
      reconciliationRepository,
  },

  providers,

  constants,
};