"use strict";

const { defineConfig } = require("@playwright/test");

const port = String(process.env.SMOKE_PORT || "4173");

module.exports = defineConfig({
  testDir: "test/browser",
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "line",
  use: {
    baseURL: "http://127.0.0.1:" + port,
    serviceWorkers: "allow",
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  webServer: {
    command: "node test/smoke-server.js",
    url: "http://127.0.0.1:" + port + "/health",
    reuseExistingServer: false,
    timeout: 15000,
    env: { SMOKE_PORT: port },
  },
});
