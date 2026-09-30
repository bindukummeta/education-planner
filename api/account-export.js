"use strict";

const account = require("./account");

function createHandler(deps) {
  return function accountExport(req, res) {
    return account.exportAccount(req, res, deps || null);
  };
}

module.exports = createHandler(null);
module.exports.createHandler = createHandler;
