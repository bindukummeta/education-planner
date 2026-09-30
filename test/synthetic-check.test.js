"use strict";
// The synthetic probe must hit only the static app and /api/ready.
const assert = require("assert");
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const probe = require(path.join(root, "scripts", "synthetic-check.js"));

let passed = 0;
function ok(desc, cond) { assert.ok(cond, desc); passed++; }

function fakeFetch(pages) {
  const calls = [];
  return {
    calls: calls,
    fetch: async (url, opts) => {
      calls.push({ url: String(url), opts: opts || {} });
      const pathname = new URL(url).pathname;
      const found = pages[pathname];
      if (!found) return { status: 404, text: async () => "missing" };
      return { status: found.status, text: async () => found.body };
    },
  };
}

(async function () {
  const good = fakeFetch({
    "/": { status: 200, body: "<html><h1>Education Planner</h1></html>" },
    "/api/ready": { status: 200, body: "{\"ok\":true}" },
  });
  const summary = await probe.check("https://app.example", good.fetch);
  ok("probe checks the shell and readiness", summary.length === 2 && summary[0].path === "/" && summary[1].path === "/api/ready" && summary[1].status === 200);
  ok("probe does not follow redirects or call a model", good.calls.length === 2 && good.calls.every((call) => call.opts.redirect === "manual" && call.opts.method === "GET"));
  const urls = good.calls.map((call) => call.url).join(" ");
  probe.BLOCKED.forEach((part) => ok("probe url avoids " + part, urls.toLowerCase().indexOf(part) === -1));

  const planted = "SECRET_TOKEN alice@school.test sk-ant-secret";
  try {
    await probe.check("https://app.example", fakeFetch({
      "/": { status: 200, body: planted },
      "/api/ready": { status: 200, body: "{\"ok\":true}" },
    }).fetch);
    ok("shell check rejects a page without the title", false);
  } catch (err) {
    ok("shell failure does not echo the body", err.synthetic === true && err.message.indexOf("app shell") !== -1 && err.message.indexOf("SECRET_TOKEN") === -1);
  }

  try {
    await probe.check("https://app.example", fakeFetch({
      "/": { status: 200, body: "Education Planner" },
      "/api/ready": { status: 200, body: "{\"ok\":true,\"missing\":[\"ANTHROPIC_API_KEY\"],\"note\":\"" + planted + "\"}" },
    }).fetch);
    ok("ready check rejects extra fields", false);
  } catch (err) {
    ok("ready failure does not echo the body", err.message.indexOf("bare ok") !== -1 && err.message.indexOf("SECRET_TOKEN") === -1 && err.message.indexOf("ANTHROPIC") === -1);
  }

  try {
    await probe.check("https://app.example", fakeFetch({
      "/": { status: 302, body: planted },
      "/api/ready": { status: 200, body: "{\"ok\":true}" },
    }).fetch);
    ok("redirect is not success", false);
  } catch (err) {
    ok("redirect is reported as a status", err.message.indexOf("302") !== -1 && err.message.indexOf("SECRET_TOKEN") === -1);
  }

  ["https://api.anthropic.com/v1/messages", "https://user:pass@app.example", "http://app.example", "https://app.example?token=sk-ant-secret"].forEach((bad) => {
    let threw = false;
    try { probe.parseBase(bad); } catch (err) {
      threw = err.synthetic === true && err.message.indexOf("pass") === -1 && err.message.indexOf("sk-ant") === -1;
    }
    ok("rejects " + bad.split("?")[0].split("@").pop(), threw);
  });
  ok("local http is allowed for a fake", probe.parseBase("http://127.0.0.1:4173").protocol === "http:");

  const child = spawnSync(process.execPath, [path.join(root, "scripts", "synthetic-check.js")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH || "" },
  });
  ok("missing secret is the activation gate", child.status === 2 && child.stderr.indexOf("EXTERNAL ACTIVATION GATE") !== -1 && child.stderr.indexOf("sk-ant") === -1);

  console.log("synthetic-check.test.js: " + passed + " assertions passed");
})().catch((err) => { console.error(err); process.exit(1); });
