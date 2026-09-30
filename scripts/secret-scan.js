"use strict";
// Working-tree secret patterns. Does not rewrite git history.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const skip = new Set(["node_modules", "vendor", ".git", "test-results", "playwright-report", "blob-report", ".playwright"]);
const patterns = [
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "github-token", re: /ghp_[A-Za-z0-9]{36}/ },
  { name: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
];

function walk(dir, out) {
  fs.readdirSync(dir).forEach((name) => {
    if (skip.has(name)) return;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (stat.isFile() && stat.size < 2 * 1024 * 1024) out.push(full);
  });
}

const files = [];
walk(root, files);
const hits = [];
files.forEach((file) => {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (_) { return; }
  patterns.forEach((pattern) => {
    if (pattern.re.test(text)) hits.push(path.relative(root, file) + " " + pattern.name);
  });
});

if (hits.length) {
  console.error("secret scan failed:");
  hits.forEach((hit) => console.error(hit));
  process.exit(1);
}
console.log("secret scan: " + files.length + " files, no matches");
