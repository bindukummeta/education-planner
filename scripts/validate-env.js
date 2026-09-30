"use strict";
// Release check for one shell. Prints failing variable names only.
// Set ENFORCE_ENV=1 to require a complete local, staging, or production shell.
// Without that flag, the script only rejects a live binding in sync-config.js
// so CI can run it with no secrets.
const fs = require("fs");
const path = require("path");
const security = require("../api/security");

const shippedPath = path.join(__dirname, "..", "sync-config.js");
const shipped = fs.readFileSync(shippedPath, "utf8");
let failed = false;

function fail(message) {
  failed = true;
  console.error("validate-env: " + message);
}

if (shipped.indexOf("supabase.co") !== -1 || shipped.indexOf("eyJ") !== -1) {
  fail("sync-config.js must not contain a Supabase host or a JWT");
}

const betaMode = typeof process.env.BETA_MODE === "string" ? process.env.BETA_MODE.trim() : "";
if (betaMode && betaMode !== "on" && betaMode !== "open") {
  fail("BETA_MODE must be on, open, or unset");
}

if (process.env.ENFORCE_ENV !== "1") {
  if (failed) process.exit(1);
  console.log("validate-env: shipped config has no live binding; set ENFORCE_ENV=1 to check this shell");
  process.exit(0);
}

const pub = security.publicRuntimeConfig(process.env);
const server = security.securityConfig(process.env);
const reports = typeof process.env.CLIENT_ERROR_REPORTS === "string"
  ? process.env.CLIENT_ERROR_REPORTS.trim()
  : "";

if (!pub.ok) {
  const vercel = typeof process.env.VERCEL_ENV === "string" ? process.env.VERCEL_ENV.trim() : "";
  const app = typeof process.env.APP_ENV === "string" ? process.env.APP_ENV.trim() : "";
  if (vercel === "preview" && app === "production") {
    fail("preview must not serve production public config");
  } else if (!app) {
    fail("APP_ENV is missing");
  } else {
    fail("public config refused for this APP_ENV and VERCEL_ENV pairing");
  }
}
if (!server.ok) fail("server config missing: " + server.missing.join(","));
if (reports && reports !== "on") fail("CLIENT_ERROR_REPORTS must be empty or on");

if (failed) process.exit(1);
console.log("validate-env: " + pub.environment + " ok");
