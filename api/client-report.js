// Accepts a privacy-safe browser error report. Disabled unless
// CLIENT_ERROR_REPORTS is exactly "on". The logged record is the allowlisted
// shape from report-policy.js. Messages, stacks, tokens, and page data are
// not logged. Rate limits are per server instance.
const security = require("./security");
const policy = require("../report-policy");
const privacy = require("../privacy");

const MAX_BODY = 1024;
const IP_PER_MINUTE = 5;
const IP_PER_DAY = 20;
const GLOBAL_PER_MINUTE = 30;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const buckets = new Map();

function reportsEnabled(env) {
  const value = env && env.CLIENT_ERROR_REPORTS;
  return typeof value === "string" && value.trim() === "on";
}

function allow(store, key, now, windowMs, max) {
  const prev = store.get(key) || [];
  const fresh = [];
  for (let i = 0; i < prev.length; i++) {
    if (now - prev[i] < windowMs) fresh.push(prev[i]);
  }
  if (fresh.length >= max) {
    store.set(key, fresh);
    return false;
  }
  fresh.push(now);
  store.set(key, fresh);
  return true;
}

function bodyTooLarge(req) {
  const header = req && req.headers ? req.headers["content-length"] || req.headers["Content-Length"] : "";
  const declared = Number(header);
  if (Number.isFinite(declared) && declared > MAX_BODY) return true;
  if (typeof req.body === "string" && req.body.length > MAX_BODY) return true;
  if (req.body && typeof req.body === "object") {
    try {
      if (JSON.stringify(req.body).length > MAX_BODY) return true;
    } catch (_) {
      return true;
    }
  }
  return false;
}

function readReport(req) {
  let body = req ? req.body : null;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (_) { return null; }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  for (let i = 0; i < keys.length; i++) {
    if (policy.ALLOWED_KEYS.indexOf(keys[i]) === -1) return null;
  }
  return policy.sanitize(body);
}

function pruneMemory(store, now) {
  const keys = [];
  store.forEach(function (_stamps, key) { keys.push(key); });
  keys.forEach(function (key) {
    const fresh = privacy.pruneTimestamps(store.get(key), now, privacy.LOG_RETENTION_MS);
    if (!fresh.length) store.delete(key);
    else store.set(key, fresh);
  });
}

function createHandler(deps) {
  return async function clientReport(req, res) {
    const started = Date.now();
    const requestId = security.newRequestId();
    const sink = deps && deps.log;
    const env = deps && deps.env ? deps.env : process.env;
    const store = deps && deps.buckets ? deps.buckets : buckets;
    const now = deps && typeof deps.now === "function" ? deps.now() : Date.now();
    pruneMemory(store, now);
    const headers = { "x-request-id": requestId, "cache-control": "no-store" };

    function emit(outcome, status, extra) {
      security.writeLog(Object.assign({
        requestId: requestId,
        endpoint: "client-report",
        outcome: outcome,
        httpStatus: status,
        durationMs: Math.max(0, Date.now() - started),
      }, extra || {}), sink);
    }

    function send(status, outcome, extra) {
      emit(outcome, status, extra);
      return security.writeJson(res, status, { ok: status === 200 }, headers);
    }

    if (!req || req.method !== "POST") return send(405, "method_not_allowed");
    if (bodyTooLarge(req)) return send(413, "payload_too_large");
    if (!reportsEnabled(env)) return send(200, "disabled");

    const report = readReport(req);
    if (!report) return send(400, "invalid_request");

    const ipHash = security.hashIp(env, req);
    if (!ipHash) return send(503, "not_configured");
    const permitted = allow(store, "ip-m:" + ipHash, now, MINUTE, IP_PER_MINUTE) &&
      allow(store, "ip-d:" + ipHash, now, DAY, IP_PER_DAY) &&
      allow(store, "global-m", now, MINUTE, GLOBAL_PER_MINUTE);
    if (!permitted) return send(429, "rate_limited", { ipHash: ipHash });

    return send(200, "ok", {
      ipHash: ipHash,
      kind: report.kind,
      errorName: report.errorName,
      source: report.source,
      line: report.line,
      column: report.column,
    });
  };
}

module.exports = createHandler(null);
module.exports.createHandler = createHandler;
module.exports.LIMITS = {
  maxBody: MAX_BODY,
  ipPerMinute: IP_PER_MINUTE,
  ipPerDay: IP_PER_DAY,
  globalPerMinute: GLOBAL_PER_MINUTE,
};
