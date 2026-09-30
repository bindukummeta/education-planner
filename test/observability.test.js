"use strict";
// Privacy-safe logs, readiness, and browser error reports.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const security = require(path.join(root, "api", "security.js"));
const ready = require(path.join(root, "api", "ready.js"));
const clientReport = require(path.join(root, "api", "client-report.js"));
const coach = require(path.join(root, "api", "coach.js"));
const practice = require(path.join(root, "api", "generate-practice.js"));
const analyse = require(path.join(root, "api", "analyse-homework.js"));
const policy = require(path.join(root, "report-policy.js"));
const browserReport = require(path.join(root, "client-report.js"));

let passed = 0;
function ok(desc, cond) { assert.ok(cond, desc); passed++; }

const USER = "22222222-2222-4222-8222-222222222222";
const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key-0123456789abcdef",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-0123456789abcdef",
  API_QUOTA_PEPPER: "pepper-0123456789abcdef",
  ANTHROPIC_API_KEY: "test-anthropic-key-0123456789",
};
const LEAK = "alice@school.test Alice ExampleSchool sk-ant-secret data:image/png;base64,AAAA worksheet prompt";

function read(rel) { return fs.readFileSync(path.join(root, rel), "utf8"); }

function mockRes() {
  const headers = {};
  const out = {
    statusCode: 0,
    jsonBody: undefined,
    ended: false,
    headers: headers,
    setHeader(key, value) { headers[String(key).toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.jsonBody = payload; return this; },
    end() { this.ended = true; return this; },
  };
  return out;
}

async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return res;
}

function leaked(value) {
  const text = JSON.stringify(value);
  return ["alice@school.test", "Alice", "ExampleSchool", "sk-ant-secret", "data:image", "worksheet prompt", "AAAA"]
    .some((part) => text.indexOf(part) !== -1);
}

function aiHandler(mod, logs, calls) {
  return mod.createHandler({
    env: ENV,
    log: (entry) => logs.push(entry),
    verifyAccessToken: async () => ({ userId: USER }),
    consumeQuota: async () => ({ ok: true }),
    releaseConcurrency: async () => {},
    fetch: async (url) => {
      calls.push(String(url));
      if (mod === practice) {
        return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ questions: [{ questionText: "3+3", expectedAnswer: "6", hint: "add" }] }) }] }) };
      }
      if (mod === analyse) {
        return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ overall: { reasoningSummary: "Next.", confidence: 0.5 }, attempts: [] }) }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ content: [{ text: "provider message text" }] }) };
    },
  });
}

(async function () {
  const dangerous = security.prepareLog({
    requestId: "0123456789abcdef",
    endpoint: "coach",
    outcome: "upstream_error",
    httpStatus: 502,
    durationMs: 12,
    providerStatus: 400,
    providerType: "invalid_request_error",
    stopReason: "the child Alice wrote a long answer",
    prompt: LEAK,
    message: LEAK,
    image: LEAK,
    token: LEAK,
    email: "alice@school.test",
    errorName: "Alice",
  });
  ok("structured log drops prompts, names, and provider text", !leaked(dangerous) && dangerous.providerType === "invalid_request_error" && dangerous.errorName === undefined && dangerous.stopReason === undefined);
  ok("stop reason code is kept", security.prepareLog({ stopReason: "max_tokens" }).stopReason === "max_tokens");
  policy.ERROR_NAMES.forEach((name) => {
    ok("error name " + name + " is loggable", security.prepareLog({ errorName: name }).errorName === name);
  });
  ok("quota driver name is loggable", security.prepareLog({ errorName: "PostgrestError" }).errorName === "PostgrestError");

  const lines = [];
  const orig = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    security.logEvent({ endpoint: "ready", outcome: "ok", httpStatus: 200, durationMs: 1, prompt: LEAK, requestId: "0123456789abcdef" });
  } finally {
    console.log = orig;
  }
  const printed = JSON.parse(lines[0]);
  ok("console log is one JSON object", printed.endpoint === "ready" && printed.requestId === "0123456789abcdef" && printed.ts && !leaked(printed));

  let fetched = false;
  const readyLogs = [];
  const readyHandler = ready.createHandler({
    env: ENV,
    fetch: () => { fetched = true; throw new Error("network"); },
    log: (entry) => readyLogs.push(entry),
  });
  const readyRes = await call(readyHandler, { method: "GET", headers: {} });
  ok("ready is 200 without a network call", readyRes.statusCode === 200 && readyRes.jsonBody.ok === true && Object.keys(readyRes.jsonBody).length === 1 && fetched === false);
  ok("ready returns a request id", /^[a-f0-9]{16}$/.test(readyRes.headers["x-request-id"]) && readyLogs[0].requestId === readyRes.headers["x-request-id"]);
  ok("ready log has no secrets", !leaked(readyLogs) && readyLogs[0].endpoint === "ready" && readyLogs[0].outcome === "ok");
  ok("ready source does not call Anthropic", read("api/ready.js").indexOf("api.anthropic.com") === -1 && read("api/ready.js").indexOf("fetch(") === -1);

  const head = await call(readyHandler, { method: "HEAD", headers: {} });
  ok("ready HEAD has no body", head.statusCode === 200 && head.ended === true && head.jsonBody === undefined);

  const secretEnv = Object.assign({}, ENV, { ANTHROPIC_API_KEY: "<super-secret-value-not-in-output>" });
  const closedLogs = [];
  const closed = await call(ready.createHandler({ env: secretEnv, log: (entry) => closedLogs.push(entry) }), { method: "GET", headers: {} });
  ok("unready config is a bare 503", closed.statusCode === 503 && JSON.stringify(closed.jsonBody) === "{\"ok\":false}");
  ok("unready body hides the variable and the secret", JSON.stringify(closed.jsonBody).indexOf("ANTHROPIC") === -1 && JSON.stringify(closed.jsonBody).indexOf("super-secret-value-not-in-output") === -1);
  ok("unready log names the check and hides the secret", closedLogs[0].missing.indexOf("ANTHROPIC_API_KEY") !== -1 && JSON.stringify(closedLogs).indexOf("super-secret-value-not-in-output") === -1);

  const denied = await call(readyHandler, { method: "POST", headers: {} });
  ok("ready rejects POST", denied.statusCode === 405 && denied.jsonBody.ok === false);

  const routes = [
    [coach, { snapshot: { subjects: [{ subject: "Maths", recentAvg: 62 }] } }, "provider message text"],
    [practice, { subject: "english", samples: [{ questionText: "2+2", expectedAnswer: "4" }] }, "3+3"],
    [analyse, { subject: "maths", images: [{ mediaType: "image/jpeg", data: "aaaa" }] }, "aaaa"],
  ];
  for (let i = 0; i < routes.length; i++) {
    const logs = [];
    const calls = [];
    const res = await call(aiHandler(routes[i][0], logs, calls), {
      method: "POST",
      headers: { authorization: "Bearer aaaaaaaa.bbbbbbbb.cccccccc", "x-real-ip": "203.0.113.10" },
      body: routes[i][1],
    });
    ok("AI route " + i + " returns its request id", res.statusCode === 200 && res.headers["x-request-id"] === logs[0].requestId);
    ok("AI route " + i + " log hides the payload", JSON.stringify(logs).indexOf(routes[i][2]) === -1 && JSON.stringify(logs).indexOf(USER) === -1);
    ok("AI route " + i + " reached the provider mock", calls.some((url) => url.indexOf("api.anthropic.com") !== -1));
  }

  ["api/coach.js", "api/generate-practice.js", "api/analyse-homework.js"].forEach((file) => {
    ok(file + " uses the shared gate", read(file).indexOf("security.protect") !== -1);
  });
  ["api/ready.js", "api/client-report.js"].forEach((file) => {
    const src = read(file);
    ok(file + " uses the shared logger and request ids", src.indexOf("security.writeLog") !== -1 && src.indexOf("security.newRequestId") !== -1);
  });
  const apiFiles = fs.readdirSync(path.join(root, "api")).filter((name) => name.endsWith(".js"));
  apiFiles.forEach((name) => {
    if (name === "security.js") return;
    ok(name + " does not print its own log line", read("api/" + name).indexOf("console.log") === -1);
  });

  function reportHandler(extra) {
    const logs = [];
    const store = extra && extra.buckets ? extra.buckets : new Map();
    const handler = clientReport.createHandler(Object.assign({
      env: Object.assign({ CLIENT_ERROR_REPORTS: "on" }, ENV),
      log: (entry) => logs.push(entry),
      buckets: store,
      now: extra && extra.now ? extra.now : () => 1700000000000,
    }, extra || {}));
    return { handler: handler, logs: logs, buckets: store };
  }

  async function post(handler, body, ip) {
    return call(handler, {
      method: "POST",
      headers: { "content-length": String(JSON.stringify(body).length), "x-real-ip": ip || "203.0.113.10" },
      body: body,
    });
  }

  const good = reportHandler();
  const accepted = await post(good.handler, { kind: "error", name: "TypeError", source: "app.js", line: 12, column: 2 });
  ok("client report accepts an allowlisted event", accepted.statusCode === 200 && accepted.jsonBody.ok === true && accepted.headers["x-request-id"] === good.logs[0].requestId);
  ok("client report log keeps kind and file only", good.logs[0].kind === "error" && good.logs[0].errorName === "TypeError" && good.logs[0].source === "app.js" && good.logs[0].line === 12);
  const bare = reportHandler({ env: { CLIENT_ERROR_REPORTS: "on" } });
  const refused = await post(bare.handler, { kind: "error", name: "TypeError", source: "app.js", line: 1 });
  ok("client report without a pepper does not use a static hash", refused.statusCode === 503 && JSON.stringify(bare.logs).indexOf("client-report-v1") === -1);

  const dirty = reportHandler();
  const named = await post(dirty.handler, { kind: "error", name: "Alice", source: "Alice at ExampleSchool", line: 4 });
  ok("unknown name and file are replaced", named.statusCode === 200 && dirty.logs[0].errorName === "Error" && dirty.logs[0].source === "other" && !leaked(dirty.logs));

  const extra = reportHandler();
  const rejected = await post(extra.handler, {
    kind: "error",
    name: "TypeError",
    source: "app.js",
    message: LEAK,
    prompt: LEAK,
    image: LEAK,
    token: "sk-ant-secret",
    email: "alice@school.test",
  });
  ok("extra report fields are rejected and not logged", rejected.statusCode === 400 && rejected.jsonBody.ok === false && extra.logs[0].outcome === "invalid_request" && !leaked(extra.logs) && !leaked(rejected.jsonBody));

  const off = reportHandler({ env: ENV });
  const dropped = await post(off.handler, { kind: "error", name: "TypeError", source: "app.js", message: LEAK });
  ok("reports stay off until the host flag is on", dropped.statusCode === 200 && off.logs[0].outcome === "disabled" && off.logs[0].kind === undefined && !leaked(off.logs));

  const limited = reportHandler();
  let last = null;
  for (let i = 0; i < clientReport.LIMITS.ipPerMinute + 1; i++) {
    last = await post(limited.handler, { kind: "error", name: "TypeError", source: "app.js", line: i });
  }
  ok("client report rate limit hides the body", last.statusCode === 429 && limited.logs[limited.logs.length - 1].outcome === "rate_limited" && !leaked(limited.logs));
  ok("rate limit log has a hash instead of the ip", /^[a-f0-9]{32}$/.test(limited.logs[limited.logs.length - 1].ipHash) && JSON.stringify(limited.logs).indexOf("203.0.113.10") === -1);

  let clock = 1700000000000;
  const daily = reportHandler({ now: () => clock });
  let dailyLast = null;
  const waves = clientReport.LIMITS.ipPerDay / clientReport.LIMITS.ipPerMinute;
  for (let wave = 0; wave < waves; wave++) {
    for (let i = 0; i < clientReport.LIMITS.ipPerMinute; i++) {
      dailyLast = await post(daily.handler, { kind: "unhandledrejection", name: "UnhandledRejection", source: "other" });
      ok("daily window still open", dailyLast.statusCode === 200);
    }
    clock += 61000;
  }
  dailyLast = await post(daily.handler, { kind: "unhandledrejection", name: "UnhandledRejection", source: "other" });
  ok("daily client report cap", dailyLast.statusCode === 429);

  const globalLogs = [];
  const globalStore = new Map();
  const globalHandler = clientReport.createHandler({
    env: Object.assign({ CLIENT_ERROR_REPORTS: "on" }, ENV),
    log: (entry) => globalLogs.push(entry),
    buckets: globalStore,
    now: () => 1700000000000,
  });
  const ips = Math.ceil(clientReport.LIMITS.globalPerMinute / clientReport.LIMITS.ipPerMinute);
  for (let n = 0; n < clientReport.LIMITS.globalPerMinute; n++) {
    const res = await post(globalHandler, { kind: "error", name: "Error", source: "storage.js", line: 1 }, "203.0.113." + (n % ips));
    ok("global window accepts " + n, res.statusCode === 200);
  }
  const globalBlocked = await post(globalHandler, { kind: "error", name: "Error", source: "storage.js", line: 1 }, "198.51.100.20");
  ok("per-instance cap", globalBlocked.statusCode === 429);

  const huge = await call(good.handler, { method: "POST", headers: { "content-length": "5000" }, body: LEAK });
  ok("oversized report is refused", huge.statusCode === 413 && !leaked(good.logs.slice(-1)));

  const browserPosts = [];
  const listeners = {};
  const win = {
    EDU_OBSERVABILITY: { clientReports: true },
    EduReportPolicy: policy,
    location: { origin: "http://127.0.0.1:4173" },
    navigator: { sendBeacon: (url, body) => { browserPosts.push({ url: url, body: String(body) }); return true; } },
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  ok("browser reporter installs only when opted in", browserReport.install(win).enabled === true);
  listeners.error({
    filename: "http://127.0.0.1:4173/app.js?child=Alice",
    lineno: 40,
    colno: 2,
    message: LEAK,
    error: { name: "TypeError", message: LEAK },
  });
  const sent = JSON.parse(browserPosts[0].body);
  ok("browser payload is allowlisted", sent.kind === "error" && sent.name === "TypeError" && sent.source === "app.js" && sent.line === 40 && !leaked(sent));
  listeners.error({ filename: "https://evil.example/app.js", lineno: 1, colno: 1, message: LEAK, error: { name: "Alice", message: LEAK } });
  const foreign = JSON.parse(browserPosts[1].body);
  ok("cross-origin errors hide the url and the name", foreign.source === "other" && foreign.name === "Error" && !leaked(foreign));
  listeners.unhandledrejection({ reason: LEAK });
  ok("rejection text is not sent", browserPosts.length === 3 && !leaked(JSON.parse(browserPosts[2].body)));
  const beforeCap = browserPosts.length;
  for (let i = 0; i < 10; i++) listeners.error({ filename: "app.js", lineno: 100 + i, colno: 1, error: { name: "Error" } });
  ok("browser stops after the page cap", browserPosts.length === browserReport.MAX_PER_PAGE && browserPosts.length < beforeCap + 10);

  const quiet = { EDU_OBSERVABILITY: { clientReports: false }, addEventListener: () => { throw new Error("listener"); } };
  ok("default install does nothing", browserReport.install(quiet).enabled === false);
  ok("shipped config is opt-in off", read("observability-config.js").indexOf("clientReports: false") !== -1);
  ok("shell loads the reporter before the app", read("index.html").indexOf("client-report.js") < read("index.html").indexOf("app.js"));
  const worker = read("service-worker.js");
  ok("service worker precaches the reporter", worker.indexOf("eduplanner-v64") !== -1 && worker.indexOf("./client-report.js") !== -1 && worker.indexOf("./report-policy.js") !== -1 && worker.indexOf("./privacy.js") !== -1);

  const alerts = JSON.parse(read("ops/alerts.json"));
  const doc = read("docs/observability.md");
  ok("external activation gate is blocked", alerts.externalActivationGate.status === "blocked" && doc.indexOf("External activation gate") !== -1);
  const ids = ["request_volume", "http_4xx", "http_5xx", "latency_p95", "timeouts", "quota_denials", "anthropic_spend", "supabase_storage_growth"];
  const providers = {};
  ids.forEach((id) => {
    const signal = alerts.signals.filter((item) => item.id === id)[0];
    ok(id + " is actionable", !!signal && typeof signal.threshold === "number" && signal.query.length > 0 && signal.steps.length > 0 && signal.window && signal.comparator === "gt");
    ok(id + " is in the runbook", doc.indexOf("`" + id + "`") !== -1);
    providers[signal.provider] = true;
  });
  ok("alerts cover vercel, supabase, and anthropic", providers.vercel && providers.supabase && providers.anthropic);
  ok("runbook names the secret and forbids a model call", doc.indexOf("SYNTHETIC_BASE_URL") !== -1 && doc.indexOf("must not call Anthropic") !== -1);
  ok("pull request CI does not need the synthetic secret", read(".github/workflows/ci.yml").indexOf("SYNTHETIC_BASE_URL") === -1);
  const synthetic = read(".github/workflows/synthetic.yml");
  ok("synthetic workflow is scheduled and manual", synthetic.indexOf("workflow_dispatch") !== -1 && synthetic.indexOf("cron:") !== -1 && synthetic.indexOf("secrets.SYNTHETIC_BASE_URL") !== -1 && synthetic.indexOf("scripts/synthetic-check.js") !== -1);

  console.log("observability.test.js: " + passed + " assertions passed");
})().catch((err) => { console.error(err); process.exit(1); });
