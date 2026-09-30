"use strict";
// Local load and soak harness. Synthetic data, a fake model, and injected
// auth and quota only. It never calls Anthropic or a live Supabase project.
const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const security = require(path.join(ROOT, "api", "security"));
const ready = require(path.join(ROOT, "api", "ready"));
const coach = require(path.join(ROOT, "api", "coach"));
const practice = require(path.join(ROOT, "api", "generate-practice"));
const analyse = require(path.join(ROOT, "api", "analyse-homework"));

const SYNTHETIC_USER = "11111111-1111-4111-8111-111111111111";
const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key-0123456789abcdef",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-0123456789abcdef",
  API_QUOTA_PEPPER: "pepper-0123456789abcdef",
  ANTHROPIC_API_KEY: "test-anthropic-key-0123456789",
  BETA_MODE: "on",
};
const PROFILES = {
  smoke: { static: 12, ready: 12, sync: 8, coach: 4, practice: 3, homework: 2, concurrency: 2 },
  heavy: { static: 60, ready: 60, sync: 30, coach: 16, practice: 10, homework: 6, concurrency: 4 },
  soak: { static: 12, ready: 12, sync: 8, coach: 4, practice: 3, homework: 2, concurrency: 2, seconds: 20 },
};

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

function summarize(samples) {
  const latencies = samples.filter((sample) => sample.ok).map((sample) => sample.ms).sort((a, b) => a - b);
  const errors = samples.filter((sample) => !sample.ok).length;
  return {
    count: samples.length,
    errors: errors,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
  };
}

function profileAllowed(profile, env) {
  const ci = env && (env.CI === "true" || env.CI === "1");
  return !ci || profile === "smoke";
}

function loadThresholds() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "ops", "load-thresholds.json"), "utf8"));
}

function breaches(summary, threshold) {
  if (!threshold) return true;
  if (summary.errors > threshold.maxErrors) return true;
  if (summary.p95 == null || summary.p95 > threshold.p95Ms) return true;
  if (summary.p99 == null || summary.p99 > threshold.p99Ms) return true;
  return false;
}

async function pool(n, concurrency, fn) {
  const samples = new Array(n);
  let next = 0;
  async function worker() {
    while (next < n) {
      const i = next;
      next += 1;
      const started = process.hrtime.bigint();
      let ok = false;
      try {
        await fn(i);
        ok = true;
      } catch (_) {
        ok = false;
      }
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      samples[i] = { ok: ok, ms: ms };
    }
  }
  const width = Math.max(1, Math.min(concurrency, n));
  const workers = [];
  for (let i = 0; i < width; i++) workers.push(worker());
  await Promise.all(workers);
  return samples;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
  });
}

async function withStaticServer(fn) {
  const html = fs.readFileSync(path.join(ROOT, "index.html"));
  const server = http.createServer((req, res) => {
    const host = req.headers.host || "";
    if (host.indexOf("127.0.0.1") !== 0) {
      res.writeHead(400);
      res.end("local only");
      return;
    }
    if (req.url !== "/" && req.url !== "/index.html") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    if (req.method === "HEAD") return res.end();
    res.end(html);
  });
  const address = await listen(server);
  try {
    return await fn("http://127.0.0.1:" + address.port + "/");
  } finally {
    await closeServer(server);
  }
}

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

function aiDeps(kind) {
  const calls = [];
  return {
    calls: calls,
    deps: {
      env: ENV,
      log: function () {},
      verifyAccessToken: async function () { return { userId: SYNTHETIC_USER }; },
      consumeQuota: async function () { return { ok: true }; },
      releaseConcurrency: async function () {},
      betaAllows: async function (userId) { return userId === SYNTHETIC_USER; },
      fetch: async function (url) {
        const target = String(url);
        calls.push(target);
        if (target !== security.ANTHROPIC_URL) throw new Error("unexpected upstream");
        if (kind === "practice") {
          return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ questions: [{ questionText: "3+3", expectedAnswer: "6", hint: "add" }] }) }] }) };
        }
        if (kind === "homework") {
          return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ overall: { reasoningSummary: "Next.", confidence: 0.9 }, attempts: [] }) }] }) };
        }
        return { ok: true, status: 200, json: async () => ({ content: [{ text: "synthetic advice" }] }) };
      },
    },
  };
}

async function callAi(mod, kind, body) {
  const built = aiDeps(kind);
  const handler = mod.createHandler(built.deps);
  const res = mockRes();
  await handler({
    method: "POST",
    headers: { authorization: "Bearer synthetic.token.only", "x-real-ip": "203.0.113.50" },
    body: body,
  }, res);
  if (res.statusCode !== 200) throw new Error("status " + res.statusCode);
  if (!built.calls.length || built.calls.some((url) => url !== security.ANTHROPIC_URL)) throw new Error("upstream");
  return res;
}

function loadSync(win) {
  const src = fs.readFileSync(path.join(ROOT, "sync.js"), "utf8");
  const sandbox = {
    window: win,
    console: console,
    Promise: Promise,
    Date: Date,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    document: { addEventListener: function () {}, hidden: false },
    location: { origin: "http://127.0.0.1", pathname: "/", search: "", hash: "" },
    history: { replaceState: function () {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "sync.js" });
  return win.EduSync;
}

async function syntheticSync() {
  const uid = SYNTHETIC_USER;
  const calls = { upserts: [], owners: [] };
  let armed = false;
  let dirty = [];
  const local = {
    entries: {
      "synthetic-entry": { id: "synthetic-entry", subject: "maths", score: 1, updatedAt: 10 },
    },
  };
  const sb = {
    auth: {
      onAuthStateChange: function () {},
      getSession: async function () {
        if (!armed) return { data: { session: null } };
        return { data: { session: { access_token: "synthetic-token", user: { id: uid } } } };
      },
    },
    from: function () {
      return {
        upsert: async function (row) {
          calls.upserts.push(row);
          if (!row || row.owner !== uid) return { error: { message: "owner mismatch" } };
          return { error: null };
        },
        select: function () {
          let owner = null;
          const api = {
            eq: function (col, val) {
              if (col === "owner") {
                owner = val;
                calls.owners.push(val);
              }
              return api;
            },
            gte: function () { return api; },
            order: function () { return api; },
            range: function () {
              if (owner !== uid) return Promise.resolve({ data: null, error: { message: "owner scope" } });
              return Promise.resolve({ data: [], error: null });
            },
          };
          return api;
        },
      };
    },
    storage: {
      from: function () {
        return {
          upload: async function () { return { error: { message: "synthetic sync has no blobs" } }; },
          download: async function () { return { data: null, error: { message: "synthetic sync has no blobs" } }; },
          remove: async function () { return { error: null }; },
        };
      },
    },
  };
  const win = {
    supabase: { createClient: function () { return sb; } },
    EDU_SYNC_CONFIG: { url: "https://example.supabase.co", anonKey: "anon-key-0123456789abcdef" },
    addEventListener: function () {},
    EduStore: {
      onChange: function () {},
      getDirty: async function () { return dirty.slice(); },
      getRecord: async function (store, id) { return (local[store] || {})[id]; },
      clearDirty: async function () { dirty = []; },
      getMeta: async function () { return 0; },
      setMeta: async function () {},
      getBlob: async function () { return null; },
      getTombstones: async function () { return []; },
      applyRemote: async function () { return false; },
      applyRemoteDelete: async function () {},
      isSyncedMetaKey: function () { return false; },
    },
  };
  const engine = loadSync(win);
  engine.init(win.EDU_SYNC_CONFIG);
  await new Promise((resolve) => setImmediate(resolve));
  armed = true;
  return {
    calls: calls,
    run: async function () {
      dirty = [{ key: "entries:synthetic-entry", store: "entries", id: "synthetic-entry", updatedAt: Date.now() }];
      const status = await engine.syncNow();
      if (!status || status.error) throw new Error("sync");
      const wrote = calls.upserts[calls.upserts.length - 1];
      if (!wrote || wrote.owner !== uid || wrote.store !== "entries" || wrote.id !== "synthetic-entry") {
        throw new Error("owner");
      }
      if (calls.owners.some((owner) => owner !== uid)) throw new Error("pull owner");
    },
  };
}

const HOMEWORK_IMAGE = Buffer.from("synthetic-image-bytes-not-a-child").toString("base64");

function mergeSamples(into, extra) {
  Object.keys(extra).forEach((name) => {
    if (!into[name]) into[name] = [];
    into[name] = into[name].concat(extra[name]);
  });
}

async function collectRaw(profile, syncer, shellUrl, seconds) {
  const started = Date.now();
  const bags = {};
  do {
    const once = await runOnceRaw(profile, syncer, shellUrl);
    mergeSamples(bags, once);
  } while (seconds && Date.now() - started < seconds * 1000);
  return bags;
}

async function runOnceRaw(profile, syncer, shellUrl) {
  const spec = PROFILES[profile] || PROFILES.smoke;
  const out = {};
  out.static_shell = await pool(spec.static, spec.concurrency, async function () {
    const res = await httpGet(shellUrl);
    if (res.status !== 200 || res.body.indexOf("Education Planner") === -1) throw new Error("shell");
  });
  const readyHandler = ready.createHandler({ env: ENV, log: function () {} });
  out.readiness = await pool(spec.ready, spec.concurrency, async function () {
    const res = mockRes();
    await readyHandler({ method: "GET", headers: {} }, res);
    if (res.statusCode !== 200 || !res.body || res.body.ok !== true) throw new Error("ready");
  });
  out.sync = await pool(spec.sync, 1, async function () {
    await syncer.run();
  });
  out.coach = await pool(spec.coach, spec.concurrency, async function () {
    await callAi(coach, "coach", { snapshot: { subjects: [{ subject: "Maths", recentAvg: 50 }] } });
  });
  out.generate_practice = await pool(spec.practice, spec.concurrency, async function () {
    await callAi(practice, "practice", {
      subject: "maths",
      topic: "addition",
      errorType: "calculation",
      samples: [{ questionText: "2+2", expectedAnswer: "4" }],
      count: 1,
    });
  });
  out.analyse_homework = await pool(spec.homework, spec.concurrency, async function () {
    await callAi(analyse, "homework", {
      subject: "maths",
      images: [{ mediaType: "image/jpeg", data: HOMEWORK_IMAGE }],
    });
  });
  return out;
}

async function runProfile(profile, options) {
  const name = PROFILES[profile] ? profile : "";
  if (!name) throw new Error("unknown profile");
  const env = options && options.env ? options.env : process.env;
  if (!profileAllowed(name, env)) {
    const error = new Error("CI runs the smoke profile only");
    error.code = "ci_smoke_only";
    throw error;
  }
  const seconds = name === "soak"
    ? Math.min(600, Math.max(1, Number(options && options.seconds) || PROFILES.soak.seconds))
    : 0;
  const thresholds = loadThresholds().scenarios;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function blockedFetch() {
    throw new Error("load harness blocked a real network fetch");
  };
  try {
    return await withStaticServer(async function (shellUrl) {
      const syncer = await syntheticSync();
      const raw = await collectRaw(name === "soak" ? "soak" : name, syncer, shellUrl, seconds);
      const scenarios = {};
      Object.keys(raw).forEach((key) => {
        scenarios[key] = summarize(raw[key]);
        scenarios[key].pass = !breaches(scenarios[key], thresholds[key]);
      });
      const ok = Object.keys(scenarios).every((key) => scenarios[key].pass);
      return {
        profile: name,
        provider: "fake",
        data: "synthetic",
        network: "blocked",
        scenarios: scenarios,
        ok: ok,
      };
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function parseArgs(argv) {
  const out = { profile: "smoke", seconds: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") out.profile = argv[i + 1] || "";
    if (argv[i] === "--seconds") out.seconds = Number(argv[i + 1]);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!profileAllowed(args.profile, process.env)) {
    console.error("CI runs the smoke profile only. Heavier runs are local.");
    process.exit(2);
  }
  const report = await runProfile(args.profile, { seconds: args.seconds, env: process.env });
  console.log(JSON.stringify(report));
  if (!report.ok) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    const code = err && err.code === "ci_smoke_only" ? 2 : 1;
    console.error("load-harness: " + (err && err.code === "ci_smoke_only" ? err.message : "failed"));
    process.exit(code);
  });
}

module.exports = {
  percentile: percentile,
  summarize: summarize,
  profileAllowed: profileAllowed,
  breaches: breaches,
  runProfile: runProfile,
  PROFILES: PROFILES,
  SYNTHETIC_USER: SYNTHETIC_USER,
};
