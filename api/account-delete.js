"use strict";

const account = require("./account");

function createHandler(deps) {
  return function accountDelete(req, res) {
    return account.deleteAccount(req, res, deps || null);
  };
}

module.exports = createHandler(null);
module.exports.createHandler = createHandler;
