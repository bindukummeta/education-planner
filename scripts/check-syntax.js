"use strict";
// Syntax-check first-party JavaScript. Vendor bundles and installed
// dependencies are skipped; they are not authored in this repo.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const skip = new Set([
  "node_modules",
  "vendor",
  ".git",
  "test-results",
  "playwright-report",
  "blob-report",
  ".playwright",
]);

function walk(dir, out) {
  fs.readdirSync(dir).forEach((name) => {
    if (skip.has(name)) return;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (name.endsWith(".js")) out.push(full);
  });
}

const files = [];
walk(root, files);
files.sort();
if (!files.length) {
  console.error("no javascript files found");
  process.exit(1);
}

let failed = 0;
files.forEach((file) => {
  const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (res.status !== 0) {
    failed += 1;
    process.stderr.write(path.relative(root, file) + "\n" + (res.stderr || res.stdout || "") + "\n");
  }
});

if (failed) {
  console.error("syntax check failed: " + failed + " file(s)");
  process.exit(1);
}
console.log("syntax check: " + files.length + " files ok");
