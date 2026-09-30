"use strict";
// Probes the static app and the non-billable readiness route.
// Set SYNTHETIC_BASE_URL to an https origin (http is accepted only for
// 127.0.0.1 and localhost). This script never calls Anthropic or the AI routes.

const BLOCKED = [
  "anthropic.com",
  "/api/coach",
  "/api/analyse-homework",
  "/api/generate-practice",
  "/api/client-report",
  "/api/account-export",
  "/api/account-delete",
];

function fail(message) {
  const error = new Error(message);
  error.synthetic = true;
  return error;
}

function parseBase(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw fail("EXTERNAL ACTIVATION GATE: repository secret SYNTHETIC_BASE_URL is not set");
  }
  let url;
  try { url = new URL(raw.trim()); } catch (_) {
    throw fail("SYNTHETIC_BASE_URL is not a URL");
  }
  if (url.username || url.password) throw fail("SYNTHETIC_BASE_URL must not include credentials");
  if (url.search || url.hash) throw fail("SYNTHETIC_BASE_URL must not include a query or hash");
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw fail("SYNTHETIC_BASE_URL must be https");
  }
  const host = url.hostname.toLowerCase();
  if (host === "api.anthropic.com" || host.endsWith(".anthropic.com") || host === "anthropic.com") {
    throw fail("refusing to probe Anthropic");
  }
  return url;
}

function assertSafeTarget(target) {
  const text = String(target).toLowerCase();
  for (let i = 0; i < BLOCKED.length; i++) {
    if (text.indexOf(BLOCKED[i]) !== -1) throw fail("refusing billable or report path");
  }
}

async function check(baseUrl, fetchImpl) {
  const base = parseBase(baseUrl);
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== "function") throw fail("fetch is unavailable");
  const paths = ["/", "/api/ready"];
  const results = [];
  for (let i = 0; i < paths.length; i++) {
    const target = new URL(paths[i], base);
    assertSafeTarget(target.href);
    const response = await fetchFn(target.href, {
      method: "GET",
      redirect: "manual",
      headers: { accept: paths[i] === "/" ? "text/html" : "application/json" },
    });
    const status = response && response.status;
    if (!status || status < 200 || status >= 300) {
      throw fail(paths[i] + " returned " + status);
    }
    const body = typeof response.text === "function" ? await response.text() : "";
    results.push({ path: paths[i], status: status, body: body });
  }
  if (results[0].body.indexOf("Education Planner") === -1) {
    throw fail("/ did not serve the app shell");
  }
  let ready = null;
  try { ready = JSON.parse(results[1].body); } catch (_) { ready = null; }
  if (!ready || ready.ok !== true || Object.keys(ready).length !== 1) {
    throw fail("/api/ready was not a bare ok response");
  }
  return [
    { path: "/", status: results[0].status },
    { path: "/api/ready", status: results[1].status },
  ];
}

async function main() {
  try {
    const summary = await check(process.env.SYNTHETIC_BASE_URL, globalThis.fetch);
    console.log(JSON.stringify({ ok: true, checks: summary }));
  } catch (err) {
    const message = err && err.synthetic ? err.message : "synthetic check failed";
    console.error(message);
    process.exit(err && err.message && err.message.indexOf("EXTERNAL ACTIVATION GATE") === 0 ? 2 : 1);
  }
}

module.exports = { check: check, parseBase: parseBase, BLOCKED: BLOCKED };

if (require.main === module) {
  main();
}
