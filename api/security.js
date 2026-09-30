"use strict";
// Shared gate for the AI routes: Supabase bearer auth, body limits, and
// distributed quotas. Production always calls Supabase. Tests pass deps
// (env, fetch, or verifyAccessToken + consumeQuota + releaseConcurrency)
// explicitly. There is no anonymous bypass flag.

const crypto = require("crypto");
const net = require("net");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const AUTH_TIMEOUT_MS = 5000;
const QUOTA_TIMEOUT_MS = 5000;
const ENDPOINTS = ["coach", "generate-practice", "analyse-homework"];

const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "API_QUOTA_PEPPER",
  "ANTHROPIC_API_KEY",
];

// Clock-minute and UTC-day windows, enforced in Postgres (see
// supabase/2026-ai-api-quotas.sql). Not a process-local counter.
const DEFAULT_LIMITS = {
  coach: {
    userPerMinute: 10,
    userPerDay: 40,
    ipPerMinute: 20,
    ipPerDay: 80,
    concurrency: 0,
    leaseSeconds: 0,
    upstreamTimeoutMs: 8000,
    maxBodyChars: 32000,
    maxSnapshotChars: 24000,
    maxDepth: 8,
    maxString: 800,
    maxArray: 80,
    maxKeys: 30,
  },
  "generate-practice": {
    userPerMinute: 6,
    userPerDay: 30,
    ipPerMinute: 12,
    ipPerDay: 60,
    concurrency: 0,
    leaseSeconds: 0,
    upstreamTimeoutMs: 25000,
    maxBodyChars: 24000,
    maxSamples: 6,
    maxCount: 8,
    maxQuestion: 2000,
    maxAnswer: 400,
    maxLabel: 80,
  },
  "analyse-homework": {
    userPerMinute: 3,
    userPerDay: 12,
    ipPerMinute: 6,
    ipPerDay: 24,
    concurrency: 1,
    leaseSeconds: 330,
    upstreamTimeoutMs: 290000,
    maxBodyChars: 8000000,
    maxImages: 8,
    maxDecodedBytes: 3 * 1024 * 1024,
    maxSubject: 40,
    allowedMedia: ["image/jpeg", "image/png"],
  },
};

const PUBLIC_ERRORS = {
  unauthorized: { status: 401, error: "Sign in is required to use this feature." },
  invalid_request: { status: 400, error: "The request could not be accepted." },
  payload_too_large: { status: 413, error: "The request is too large." },
  rate_limited: { status: 429, error: "Too many requests. Please wait and try again." },
  concurrency_limited: { status: 429, error: "An analysis is already running. Wait for it to finish, then try again." },
  timeout: { status: 504, error: "The request took too long. Please try again." },
  upstream_error: { status: 502, error: "The assistant is temporarily unavailable. Please try again." },
  not_configured: { status: 503, error: "This feature is temporarily unavailable." },
  not_admitted: { status: 403, error: "This beta is limited to invited families." },
  quota_unavailable: { status: 503, error: "This feature is temporarily unavailable." },
  method_not_allowed: { status: 405, error: "Use POST." },
  internal: { status: 500, error: "Something went wrong. Please try again." },
  export_too_large: { status: 413, error: "The account export is too large to download in one response." },
};

const LOG_ENDPOINTS = [
  "coach", "generate-practice", "analyse-homework", "ready", "client-report",
  "account-export", "account-delete", "public-config",
];
const ACCOUNT_ENDPOINTS = ["account-export", "account-delete"];
const LOG_OUTCOMES = [
  "ok", "unauthorized", "invalid_request", "payload_too_large", "rate_limited",
  "concurrency_limited", "timeout", "upstream_error", "not_configured",
  "quota_unavailable", "method_not_allowed", "internal", "release_failed", "disabled",
  "not_admitted", "export_too_large",
];
const LOG_SOURCES = [
  "app.js", "sync.js", "storage.js", "schools-seed.js", "sync-config.js",
  "client-report.js", "observability-config.js", "report-policy.js", "privacy.js",
  "public-config.js", "service-worker.js", "sw-boot.js", "index.html", "other",
];
const LOG_KINDS = ["error", "unhandledrejection"];
const LOG_ERROR_NAMES = [
  "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError",
  "URIError", "AggregateError", "InternalError", "AbortError", "NotAllowedError",
  "SecurityError", "NetworkError", "TimeoutError", "QuotaExceededError",
  "DataCloneError", "InvalidStateError", "NotFoundError", "NotSupportedError",
  "HierarchyRequestError", "IndexSizeError", "EncodingError", "UnknownError",
  "ConstraintError", "DataError", "TransactionInactiveError", "ReadOnlyError",
  "VersionError", "OperationError", "UnhandledRejection", "PostgrestError",
];
const MISSING_OK = [
  "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "API_QUOTA_PEPPER", "ANTHROPIC_API_KEY", "APP_ENV", "injected_dependencies",
  "BETA_MODE", "beta_access_allowed",
];

const RATE_REASONS = { user_minute: 1, user_day: 1, ip_minute: 1, ip_day: 1 };

// Invited production beta. The database trigger is the hard cap. The minimum
// is the intended cohort size, not a floor that admits strangers.
const BETA_ADMISSION_CAP = 200;
const BETA_COHORT_MIN = 50;

function keepToken(value, allowed) {
  return typeof value === "string" && allowed.indexOf(value) !== -1 ? value : undefined;
}

function keepInt(value, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < min || value > max) return undefined;
  return value;
}

function keepHash(value, length) {
  return typeof value === "string" && new RegExp("^[a-f0-9]{" + length + "}$").test(value) ? value : undefined;
}

function keepCode(value, max) {
  return typeof value === "string" && new RegExp("^[A-Za-z0-9_-]{1," + max + "}$").test(value) ? value : undefined;
}

function keepMissing(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return undefined;
  const names = [];
  for (let i = 0; i < value.length; i++) {
    if (MISSING_OK.indexOf(value[i]) === -1) return undefined;
    if (names.indexOf(value[i]) === -1) names.push(value[i]);
  }
  return names;
}

function prepareLog(entry) {
  const safe = {};
  const requestId = keepHash(entry && entry.requestId, 16);
  const endpoint = keepToken(entry && entry.endpoint, LOG_ENDPOINTS);
  const outcome = keepToken(entry && entry.outcome, LOG_OUTCOMES);
  const httpStatus = keepInt(entry && entry.httpStatus, 100, 599);
  const durationMs = keepInt(entry && entry.durationMs, 0, 3600000);
  const userHash = keepHash(entry && entry.userHash, 32);
  const ipHash = keepHash(entry && entry.ipHash, 32);
  const providerStatus = keepInt(entry && entry.providerStatus, 100, 599);
  const providerType = keepCode(entry && entry.providerType, 80);
  const stopReason = keepCode(entry && entry.stopReason, 40);
  const missing = keepMissing(entry && entry.missing);
  const errorName = keepToken(entry && entry.errorName, LOG_ERROR_NAMES);
  const source = keepToken(entry && entry.source, LOG_SOURCES);
  const kind = keepToken(entry && entry.kind, LOG_KINDS);
  const line = keepInt(entry && entry.line, 0, 1000000);
  const column = keepInt(entry && entry.column, 0, 1000000);
  const recordCount = keepInt(entry && entry.recordCount, 0, 100000);
  const blobCount = keepInt(entry && entry.blobCount, 0, 100000);
  if (requestId) safe.requestId = requestId;
  if (endpoint) safe.endpoint = endpoint;
  if (outcome) safe.outcome = outcome;
  if (httpStatus != null) safe.httpStatus = httpStatus;
  if (durationMs != null) safe.durationMs = durationMs;
  if (userHash) safe.userHash = userHash;
  if (ipHash) safe.ipHash = ipHash;
  if (providerStatus != null) safe.providerStatus = providerStatus;
  if (providerType) safe.providerType = providerType;
  if (stopReason) safe.stopReason = stopReason;
  if (missing) safe.missing = missing;
  if (errorName) safe.errorName = errorName;
  if (entry && entry.releaseFailed === true) safe.releaseFailed = true;
  if (source) safe.source = source;
  if (kind) safe.kind = kind;
  if (line != null) safe.line = line;
  if (column != null) safe.column = column;
  if (recordCount != null) safe.recordCount = recordCount;
  if (blobCount != null) safe.blobCount = blobCount;
  return safe;
}

function defaultLog(entry) {
  const safe = prepareLog(entry);
  safe.ts = new Date().toISOString();
  console.log(JSON.stringify(safe));
}

function writeLog(entry, sink) {
  if (typeof sink === "function") sink(prepareLog(entry));
  else defaultLog(entry);
}

function newRequestId() {
  return crypto.randomBytes(8).toString("hex");
}

function envOf(deps) {
  if (deps && deps.env && typeof deps.env === "object") return deps.env;
  return process.env;
}

function trimmed(env, key) {
  const value = env && env[key];
  return typeof value === "string" ? value.trim() : "";
}

function supabaseOrigin(env) {
  let url;
  try { url = new URL(trimmed(env, "SUPABASE_URL")); } catch (_) { return null; }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname && url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

function securityConfig(env) {
  const missing = [];
  if (!supabaseOrigin(env)) missing.push("SUPABASE_URL");
  ["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "API_QUOTA_PEPPER", "ANTHROPIC_API_KEY"].forEach((key) => {
    const min = key === "API_QUOTA_PEPPER" ? 16 : 20;
    if (trimmed(env, key).length < min || trimmed(env, key).indexOf("<") !== -1) missing.push(key);
  });
  if (missing.indexOf("SUPABASE_ANON_KEY") === -1 && missing.indexOf("SUPABASE_SERVICE_ROLE_KEY") === -1) {
    if (trimmed(env, "SUPABASE_ANON_KEY") === trimmed(env, "SUPABASE_SERVICE_ROLE_KEY")) {
      missing.push("SUPABASE_SERVICE_ROLE_KEY");
    }
  }
  return { ok: missing.length === 0, missing: missing };
}

const PUBLIC_ENVIRONMENTS = ["local", "staging", "production"];

// Browser-visible config only. Fail closed: a preview host never receives a
// production binding, and the service-role key is never returned. Callers must
// not cache the result into another environment.
function publicRuntimeConfig(env) {
  const refused = {
    ok: false,
    environment: "unconfigured",
    supabaseUrl: "",
    supabaseAnonKey: "",
    clientReports: false,
  };
  const appEnv = trimmed(env, "APP_ENV");
  const vercelEnv = trimmed(env, "VERCEL_ENV");
  if (PUBLIC_ENVIRONMENTS.indexOf(appEnv) === -1) return refused;
  if (vercelEnv === "preview") {
    if (appEnv === "production") return refused;
    if (trimmed(env, "ALLOW_PREVIEW_PUBLIC_CONFIG") !== appEnv) return refused;
  }
  if (vercelEnv === "production" && appEnv === "local") return refused;
  if (vercelEnv === "development" && appEnv !== "local") return refused;

  const origin = supabaseOrigin(env);
  const anon = trimmed(env, "SUPABASE_ANON_KEY");
  const service = trimmed(env, "SUPABASE_SERVICE_ROLE_KEY");
  if (!origin) return refused;
  if (anon.length < 20 || anon.indexOf("<") !== -1) return refused;
  if (service.length < 20 || service.indexOf("<") !== -1) return refused;
  if (anon === service) return refused;

  return {
    ok: true,
    environment: appEnv,
    supabaseUrl: origin,
    supabaseAnonKey: anon,
    clientReports: trimmed(env, "CLIENT_ERROR_REPORTS") === "on",
  };
}

function accountConfig(env) {
  const full = securityConfig(env);
  const missing = full.missing.filter((name) => name !== "ANTHROPIC_API_KEY");
  return { ok: missing.length === 0, missing: missing };
}

function injectionMode(deps) {
  if (!deps) return "production";
  const present = [
    typeof deps.verifyAccessToken === "function",
    typeof deps.consumeQuota === "function",
    typeof deps.releaseConcurrency === "function",
  ].filter(Boolean).length;
  if (present === 0) return "production";
  if (present === 3) return "injected";
  return "partial";
}

function readInt(env, name, fallback, min, max) {
  const raw = env && env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return Math.floor(n);
}

function limitsFor(endpoint, deps) {
  const base = Object.assign({}, DEFAULT_LIMITS[endpoint]);
  const env = envOf(deps);
  const key = endpoint.toUpperCase().replace(/-/g, "_");
  const q = "AI_QUOTA_" + key + "_";
  base.userPerMinute = readInt(env, q + "USER_PER_MINUTE", base.userPerMinute, 1, 100000);
  base.userPerDay = readInt(env, q + "USER_PER_DAY", base.userPerDay, 1, 100000);
  base.ipPerMinute = readInt(env, q + "IP_PER_MINUTE", base.ipPerMinute, 1, 100000);
  base.ipPerDay = readInt(env, q + "IP_PER_DAY", base.ipPerDay, 1, 100000);
  base.upstreamTimeoutMs = readInt(env, "AI_TIMEOUT_" + key + "_MS", base.upstreamTimeoutMs, 1000, 290000);
  if (endpoint === "analyse-homework") {
    base.concurrency = readInt(env, q + "CONCURRENCY", base.concurrency, 1, 5);
  }
  if (deps && deps.limits && typeof deps.limits === "object") {
    Object.keys(deps.limits).forEach((name) => {
      if (base[name] !== undefined) base[name] = deps.limits[name];
    });
  }
  return base;
}

function header(req, name) {
  const headers = (req && req.headers) || {};
  const want = name.toLowerCase();
  if (headers[want] != null) return headers[want];
  const found = Object.keys(headers).find((key) => key.toLowerCase() === want);
  return found ? headers[found] : undefined;
}

function normalizeIp(raw) {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value || value.length > 80) return null;
  if (value.charAt(0) === "[" && value.indexOf("]") > 1) {
    value = value.slice(1, value.indexOf("]"));
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(":"));
  }
  if (value.length > 45) return null;
  return net.isIP(value) ? value : null;
}

function rightmostIp(headerValue) {
  if (typeof headerValue !== "string" || !headerValue.trim()) return null;
  const parts = headerValue.split(",");
  for (let i = parts.length - 1; i >= 0; i--) {
    const ip = normalizeIp(parts[i]);
    if (ip) return ip;
  }
  return null;
}

// Vercel appends the connecting client to x-vercel-forwarded-for and the
// client cannot overwrite that header. The rightmost valid address is the
// platform observation. A caller-prepended X-Forwarded-For hop is never used.
function clientIp(req) {
  const vercel = rightmostIp(header(req, "x-vercel-forwarded-for"));
  if (vercel) return vercel;
  const real = normalizeIp(typeof header(req, "x-real-ip") === "string" ? header(req, "x-real-ip") : "");
  if (real) return real;
  const forwarded = rightmostIp(header(req, "x-forwarded-for"));
  if (forwarded) return forwarded;
  return "unknown";
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

function hashIp(env, req) {
  const pepper = trimmed(env, "API_QUOTA_PEPPER");
  if (pepper.length < 16) return null;
  return digest(pepper + ":ip:" + clientIp(req));
}

function bearerToken(req) {
  const raw = header(req, "authorization");
  if (typeof raw !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]{2,8192}\.[A-Za-z0-9_-]{2,8192}\.[A-Za-z0-9_-]{2,8192})$/.exec(raw.trim());
  return match ? match[1] : null;
}

function isUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function write(res, status, payload, headers) {
  if (headers && typeof res.setHeader === "function") {
    Object.keys(headers).forEach((key) => res.setHeader(key, headers[key]));
  }
  const chain = res.status(status);
  if (payload === undefined) {
    if (chain && typeof chain.end === "function") return chain.end();
    return;
  }
  return chain.json(payload);
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(url, Object.assign({}, init, { signal: ctrl.signal }));
  } catch (err) {
    const error = new Error(timedOut ? "timeout" : "upstream");
    error.code = timedOut || (err && err.name === "AbortError") ? "timeout" : "upstream_error";
    error.errorName = err && err.name ? String(err.name).slice(0, 40) : "Error";
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyWithSupabase(deps, token) {
  const env = envOf(deps);
  const origin = supabaseOrigin(env);
  const fetchImpl = (deps && deps.fetch) || globalThis.fetch;
  const timeoutMs = (deps && deps.authTimeoutMs) || AUTH_TIMEOUT_MS;
  const anon = trimmed(env, "SUPABASE_ANON_KEY");
  const service = trimmed(env, "SUPABASE_SERVICE_ROLE_KEY");
  if (!origin || !anon || token === anon || token === service) return null;
  const res = await fetchWithTimeout(fetchImpl, origin + "/auth/v1/user", {
    method: "GET",
    headers: { authorization: "Bearer " + token, apikey: anon },
  }, timeoutMs);
  if (!res || !res.ok) return null;
  const user = await res.json();
  if (!user || user.role !== "authenticated" || !isUuid(user.id)) return null;
  return { userId: user.id };
}

async function consumeWithSupabase(deps, args) {
  const env = envOf(deps);
  const origin = supabaseOrigin(env);
  const fetchImpl = (deps && deps.fetch) || globalThis.fetch;
  const timeoutMs = (deps && deps.quotaTimeoutMs) || QUOTA_TIMEOUT_MS;
  const service = trimmed(env, "SUPABASE_SERVICE_ROLE_KEY");
  if (!origin || !service) {
    const error = new Error("quota");
    error.code = "quota_unavailable";
    throw error;
  }
  const res = await fetchWithTimeout(fetchImpl, origin + "/rest/v1/rpc/consume_ai_quota", {
    method: "POST",
    headers: {
      apikey: service,
      authorization: "Bearer " + service,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      p_user_id: args.userId,
      p_ip_hash: args.ipHash,
      p_endpoint: args.endpoint,
      p_user_per_minute: args.limits.userPerMinute,
      p_user_per_day: args.limits.userPerDay,
      p_ip_per_minute: args.limits.ipPerMinute,
      p_ip_per_day: args.limits.ipPerDay,
      p_concurrency_limit: args.limits.concurrency,
      p_lease_seconds: args.limits.leaseSeconds,
    }),
  }, timeoutMs);
  if (!res || !res.ok) {
    const error = new Error("quota");
    error.code = "quota_unavailable";
    throw error;
  }
  const data = await res.json();
  if (!data || data.ok !== true) {
    return { ok: false, reason: data && data.reason ? String(data.reason) : "unavailable" };
  }
  return { ok: true, leaseId: data.lease_id || null };
}

async function releaseWithSupabase(deps, leaseId) {
  if (!leaseId) return;
  const env = envOf(deps);
  const origin = supabaseOrigin(env);
  const fetchImpl = (deps && deps.fetch) || globalThis.fetch;
  const service = trimmed(env, "SUPABASE_SERVICE_ROLE_KEY");
  const timeoutMs = (deps && deps.quotaTimeoutMs) || QUOTA_TIMEOUT_MS;
  const res = await fetchWithTimeout(fetchImpl, origin + "/rest/v1/rpc/release_ai_concurrency", {
    method: "POST",
    headers: {
      apikey: service,
      authorization: "Bearer " + service,
      "content-type": "application/json",
    },
    body: JSON.stringify({ p_lease_id: leaseId }),
  }, timeoutMs);
  if (!res || !res.ok) {
    const error = new Error("release");
    error.code = "release_failed";
    throw error;
  }
}

function readBody(req, maxChars) {
  let body = req ? req.body : null;
  if (typeof body === "string") {
    if (body.length > maxChars) return { code: "payload_too_large" };
    try { body = JSON.parse(body); } catch (_) { return { code: "invalid_request" }; }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { code: "invalid_request" };
  let serialized;
  try { serialized = JSON.stringify(body); } catch (_) { return { code: "invalid_request" }; }
  if (serialized.length > maxChars) return { code: "payload_too_large" };
  return { body: body };
}

function allowedKeys(body, allowed) {
  return Object.keys(body).every((key) => allowed.indexOf(key) !== -1);
}

function walk(value, limits, depth) {
  if (depth > limits.maxDepth) return "payload_too_large";
  if (typeof value === "string") return value.length <= limits.maxString ? null : "payload_too_large";
  if (value == null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    if (value.length > limits.maxArray) return "payload_too_large";
    for (let i = 0; i < value.length; i++) {
      const code = walk(value[i], limits, depth + 1);
      if (code) return code;
    }
    return null;
  }
  const keys = Object.keys(value);
  if (keys.length > limits.maxKeys) return "payload_too_large";
  for (let i = 0; i < keys.length; i++) {
    const code = walk(value[keys[i]], limits, depth + 1);
    if (code) return code;
  }
  return null;
}

function validateCoach(body, limits) {
  if (!allowedKeys(body, ["snapshot", "audience"])) return { code: "invalid_request" };
  if (body.audience != null && (typeof body.audience !== "string" || body.audience.length > 20)) {
    return { code: "invalid_request" };
  }
  if (!body.snapshot || typeof body.snapshot !== "object" || Array.isArray(body.snapshot)) {
    return { code: "invalid_request" };
  }
  let serialized;
  try { serialized = JSON.stringify(body.snapshot); } catch (_) { return { code: "invalid_request" }; }
  if (serialized.length > limits.maxSnapshotChars) return { code: "payload_too_large" };
  const walked = walk(body.snapshot, limits, 1);
  if (walked) return { code: walked };
  return { ok: true, value: { snapshot: body.snapshot, audience: body.audience } };
}

function shortText(value, max) {
  if (value == null || value === "") return { text: "" };
  if (typeof value !== "string") return { code: "invalid_request" };
  const text = value.trim();
  if (text.length > max) return { code: "payload_too_large" };
  return { text: text };
}

function validatePractice(body, limits) {
  if (!allowedKeys(body, ["subject", "topic", "errorType", "samples", "count"])) {
    return { code: "invalid_request" };
  }
  const subject = shortText(body.subject, limits.maxLabel);
  const topic = shortText(body.topic, limits.maxLabel);
  const errorType = shortText(body.errorType, limits.maxLabel);
  if (subject.code) return subject;
  if (topic.code) return topic;
  if (errorType.code) return errorType;
  if (!Array.isArray(body.samples) || body.samples.length < 1 || body.samples.length > limits.maxSamples) {
    return { code: "invalid_request" };
  }
  const samples = [];
  for (let i = 0; i < body.samples.length; i++) {
    const sample = body.samples[i];
    if (!sample || typeof sample !== "object" || Array.isArray(sample)) return { code: "invalid_request" };
    if (!allowedKeys(sample, ["questionText", "expectedAnswer"])) return { code: "invalid_request" };
    const questionText = shortText(sample.questionText, limits.maxQuestion);
    const expectedAnswer = shortText(sample.expectedAnswer, limits.maxAnswer);
    if (questionText.code) return questionText;
    if (expectedAnswer.code) return expectedAnswer;
    if (!questionText.text) continue;
    samples.push({ questionText: questionText.text, expectedAnswer: expectedAnswer.text });
  }
  if (!samples.length) return { code: "invalid_request" };
  let count = Number(body.count);
  if (!Number.isFinite(count) || count < 1) count = 5;
  count = Math.min(limits.maxCount, Math.max(1, Math.round(count)));
  return { ok: true, value: { subject: subject.text, topic: topic.text, errorType: errorType.text, samples: samples, count: count } };
}

function decodedBytes(data) {
  if (typeof data !== "string" || data.length % 4 !== 0) return -1;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return -1;
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - pad;
}

function validateAnalyse(body, limits) {
  if (!allowedKeys(body, ["subject", "images", "image"])) return { code: "invalid_request" };
  if (typeof body.subject !== "string") return { code: "invalid_request" };
  const subject = body.subject.trim();
  // Reject ASCII controls in the subject. The class is intentional.
  // eslint-disable-next-line no-control-regex
  if (!subject || subject.length > limits.maxSubject || /[\u0000-\u001f]/.test(subject)) {
    return { code: "invalid_request" };
  }
  let images = [];
  if (Array.isArray(body.images) && body.images.length) images = body.images;
  else if (body.image) images = [body.image];
  if (!images.length || images.length > limits.maxImages) {
    return images.length > limits.maxImages ? { code: "payload_too_large" } : { code: "invalid_request" };
  }
  let total = 0;
  const clean = [];
  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    if (!image || typeof image !== "object" || Array.isArray(image)) return { code: "invalid_request" };
    if (!allowedKeys(image, ["mediaType", "data"])) return { code: "invalid_request" };
    if (limits.allowedMedia.indexOf(image.mediaType) === -1) return { code: "invalid_request" };
    const bytes = decodedBytes(image.data);
    if (bytes < 0) return { code: "invalid_request" };
    total += bytes;
    if (total > limits.maxDecodedBytes) return { code: "payload_too_large" };
    clean.push({ mediaType: image.mediaType, data: image.data });
  }
  return { ok: true, value: { subject: subject, images: clean } };
}

const VALIDATORS = {
  coach: validateCoach,
  "generate-practice": validatePractice,
  "analyse-homework": validateAnalyse,
};

function quotaCode(reason) {
  if (RATE_REASONS[reason]) return "rate_limited";
  if (reason === "concurrency") return "concurrency_limited";
  return "quota_unavailable";
}

// Exact tokens only. Unset is not "off": production still asks
// beta_access_allowed. "off" is not a bypass. "open" still asks the database,
// which returns true only when beta_config.mode is open.
function betaMode(env) {
  const raw = trimmed(env, "BETA_MODE");
  if (!raw) return "unset";
  if (raw === "on" || raw === "open") return raw;
  return "invalid";
}

async function betaAllowsWithSupabase(deps, userId) {
  const env = envOf(deps);
  const origin = supabaseOrigin(env);
  const service = trimmed(env, "SUPABASE_SERVICE_ROLE_KEY");
  const fetchImpl = (deps && deps.fetch) || globalThis.fetch;
  if (!origin || service.length < 20) {
    const error = new Error("beta");
    error.errorName = "Error";
    throw error;
  }
  const res = await fetchWithTimeout(fetchImpl, origin + "/rest/v1/rpc/beta_access_allowed", {
    method: "POST",
    headers: {
      apikey: service,
      authorization: "Bearer " + service,
      "content-type": "application/json",
    },
    body: JSON.stringify({ uid: userId }),
  }, AUTH_TIMEOUT_MS);
  if (!res || res.ok !== true) {
    const error = new Error("beta");
    error.errorName = "Error";
    throw error;
  }
  const body = await res.json();
  return body === true;
}

// Production always verifies beta_access_allowed. Missing BETA_MODE does not
// disable the gate. Account deletion passes rightsDeletion so a removed
// family can still erase their data. A lookup error is not_configured.
async function enforceBeta(deps, env, userId, options) {
  if (options && options.rightsDeletion) return { ok: true };
  const mode = betaMode(env);
  if (mode === "invalid") return { ok: false, code: "not_configured", missing: ["BETA_MODE"] };
  if (injectionMode(deps) !== "production" && mode === "unset") return { ok: true };
  if (!isUuid(userId)) return { ok: false, code: "not_admitted" };
  try {
    let allowed;
    if (deps && typeof deps.betaAllows === "function") {
      allowed = await deps.betaAllows(userId);
    } else if (injectionMode(deps) !== "production") {
      return { ok: false, code: "not_configured", missing: ["beta_access_allowed"] };
    } else {
      allowed = await betaAllowsWithSupabase(deps, userId);
    }
    if (allowed === true) return { ok: true };
    return { ok: false, code: "not_admitted" };
  } catch (err) {
    return {
      ok: false,
      code: "not_configured",
      missing: ["beta_access_allowed"],
      errorName: err && (err.errorName || err.name),
    };
  }
}

async function protect(req, res, endpoint, deps) {
  const started = Date.now();
  const requestId = newRequestId();
  function log(entry) {
    writeLog(entry, deps && deps.log);
  }
  if (res && typeof res.setHeader === "function") res.setHeader("x-request-id", requestId);
  const limits = limitsFor(endpoint, deps);
  let userHash = null;
  let ipHash = null;
  let leaseId = null;

  function finish(code, extra) {
    const pub = PUBLIC_ERRORS[code] || PUBLIC_ERRORS.internal;
    const entry = Object.assign({
      requestId: requestId,
      endpoint: endpoint,
      outcome: code,
      httpStatus: pub.status,
      durationMs: Date.now() - started,
      userHash: userHash,
      ipHash: ipHash,
    }, extra || {});
    log(entry);
    const headers = { "x-request-id": requestId };
    if (pub.status === 429) headers["retry-after"] = "60";
    write(res, pub.status, { error: pub.error, code: code }, headers);
    return { ok: false, requestId: requestId };
  }

  if (!req || req.method !== "POST") return finish("method_not_allowed");
  if (ENDPOINTS.indexOf(endpoint) === -1) return finish("internal");

  const mode = injectionMode(deps);
  const env = envOf(deps);
  if (mode === "partial") return finish("not_configured", { missing: ["injected_dependencies"] });
  if (mode === "production") {
    const cfg = securityConfig(env);
    if (!cfg.ok) return finish("not_configured", { missing: cfg.missing });
  } else if (trimmed(env, "ANTHROPIC_API_KEY").length < 20) {
    return finish("not_configured", { missing: ["ANTHROPIC_API_KEY"] });
  }
  const injected = mode === "injected";
  if (betaMode(env) === "invalid") return finish("not_configured", { missing: ["BETA_MODE"] });

  const contentLength = Number(header(req, "content-length"));
  if (Number.isFinite(contentLength) && contentLength > limits.maxBodyChars) {
    return finish("payload_too_large");
  }

  const token = bearerToken(req);
  if (!token) return finish("unauthorized");
  let identity = null;
  try {
    const verify = injected ? deps.verifyAccessToken : (value) => verifyWithSupabase(deps, value);
    identity = await verify(token);
  } catch (err) {
    const code = err && err.code === "timeout" ? "quota_unavailable" : "quota_unavailable";
    return finish(code, { errorName: err && err.errorName });
  }
  if (!identity || !isUuid(identity.userId)) return finish("unauthorized");
  userHash = digest("user:" + identity.userId);
  ipHash = digest(trimmed(env, "API_QUOTA_PEPPER") + ":ip:" + clientIp(req));
  const beta = await enforceBeta(deps, env, identity.userId);
  if (!beta.ok) return finish(beta.code, { missing: beta.missing, errorName: beta.errorName });

  const parsed = readBody(req, limits.maxBodyChars);
  if (parsed.code) return finish(parsed.code);
  const validated = VALIDATORS[endpoint](parsed.body, limits);
  if (!validated.ok) return finish(validated.code);

  let quota;
  try {
    const consume = injected
      ? deps.consumeQuota
      : (args) => consumeWithSupabase(deps, args);
    quota = await consume({
      userId: identity.userId,
      ipHash: ipHash,
      endpoint: endpoint,
      limits: limits,
    });
  } catch (err) {
    return finish("quota_unavailable", { errorName: err && err.errorName });
  }
  if (!quota || quota.ok !== true) return finish(quotaCode(quota && quota.reason));
  leaseId = quota.leaseId || null;

  async function release() {
    if (!leaseId) return;
    const held = leaseId;
    leaseId = null;
    try {
      const releaseFn = injected ? deps.releaseConcurrency : (id) => releaseWithSupabase(deps, id);
      await releaseFn(held);
    } catch (err) {
      log({
        requestId: requestId,
        endpoint: endpoint,
        outcome: "release_failed",
        userHash: userHash,
        ipHash: ipHash,
        errorName: err && err.errorName ? err.errorName : "Error",
        releaseFailed: true,
      });
    }
  }

  return {
    ok: true,
    requestId: requestId,
    userId: identity.userId,
    body: validated.value,
    env: env,
    fetch: (deps && deps.fetch) || globalThis.fetch,
    timeoutMs: limits.upstreamTimeoutMs,
    limits: limits,
    release: release,
    fail: finish,
    succeed: function (extra) {
      log(Object.assign({
        requestId: requestId,
        endpoint: endpoint,
        outcome: "ok",
        httpStatus: 200,
        durationMs: Date.now() - started,
        userHash: userHash,
        ipHash: ipHash,
      }, extra || {}));
    },
  };
}

async function fetchUpstream(url, init, timeoutMs, fetchImpl) {
  return fetchWithTimeout(fetchImpl, url, init, timeoutMs);
}

async function providerFailure(upstream) {
  let providerType = null;
  try {
    const data = await upstream.json();
    const kind = data && data.error && data.error.type;
    if (typeof kind === "string") providerType = kind.slice(0, 80);
  } catch (_) { /* status only — never keep provider text */ }
  return { providerStatus: upstream && upstream.status, providerType: providerType };
}

function modelText(data) {
  if (!data || !Array.isArray(data.content)) return "";
  return data.content.filter((part) => part && typeof part.text === "string").map((part) => part.text).join("");
}

// Bearer check for account export and deletion. No AI quota and no Anthropic
// call. The service-role key is not required to be distinct from a missing
// Anthropic key: closing an account must still work when the model key is absent.
async function authenticate(req, res, endpoint, deps) {
  const started = Date.now();
  const requestId = newRequestId();
  const env = envOf(deps);
  function log(entry) {
    writeLog(entry, deps && deps.log);
  }
  if (res && typeof res.setHeader === "function") {
    res.setHeader("x-request-id", requestId);
    res.setHeader("cache-control", "no-store");
  }
  let userHash = null;
  let ipHash = null;

  function finish(code, extra) {
    const pub = PUBLIC_ERRORS[code] || PUBLIC_ERRORS.internal;
    log(Object.assign({
      requestId: requestId,
      endpoint: endpoint,
      outcome: LOG_OUTCOMES.indexOf(code) === -1 ? "internal" : code,
      httpStatus: pub.status,
      durationMs: Date.now() - started,
      userHash: userHash,
      ipHash: ipHash,
    }, extra || {}));
    write(res, pub.status, { error: pub.error, code: code }, {
      "x-request-id": requestId,
      "cache-control": "no-store",
    });
    return { ok: false, requestId: requestId };
  }

  if (!req || req.method !== "POST") return finish("method_not_allowed");
  if (ACCOUNT_ENDPOINTS.indexOf(endpoint) === -1) return finish("internal");
  const cfg = accountConfig(env);
  if (!cfg.ok) return finish("not_configured", { missing: cfg.missing });
  if (betaMode(env) === "invalid") return finish("not_configured", { missing: ["BETA_MODE"] });

  const token = bearerToken(req);
  if (!token) return finish("unauthorized");
  let identity = null;
  try {
    const verify = deps && typeof deps.verifyAccessToken === "function"
      ? deps.verifyAccessToken
      : (value) => verifyWithSupabase(deps, value);
    identity = await verify(token);
  } catch (err) {
    const code = err && err.code === "timeout" ? "timeout" : "internal";
    return finish(code, { errorName: err && (err.errorName || err.name) });
  }
  if (!identity || !isUuid(identity.userId)) return finish("unauthorized");
  userHash = digest("user:" + identity.userId);
  ipHash = digest(trimmed(env, "API_QUOTA_PEPPER") + ":ip:" + clientIp(req));
  const beta = await enforceBeta(deps, env, identity.userId, {
    rightsDeletion: endpoint === "account-delete",
  });
  if (!beta.ok) return finish(beta.code, { missing: beta.missing, errorName: beta.errorName });
  const origin = supabaseOrigin(env);

  return {
    ok: true,
    requestId: requestId,
    userId: identity.userId,
    origin: origin,
    env: env,
    fetch: (deps && deps.fetch) || globalThis.fetch,
    userHash: userHash,
    ipHash: ipHash,
    fail: finish,
    succeed: function (extra) {
      log(Object.assign({
        requestId: requestId,
        endpoint: endpoint,
        outcome: "ok",
        httpStatus: 200,
        durationMs: Date.now() - started,
        userHash: userHash,
        ipHash: ipHash,
      }, extra || {}));
    },
  };
}

module.exports = {
  ANTHROPIC_URL: ANTHROPIC_URL,
  REQUIRED_ENV: REQUIRED_ENV,
  DEFAULT_LIMITS: DEFAULT_LIMITS,
  PUBLIC_ERRORS: PUBLIC_ERRORS,
  protect: protect,
  fetchUpstream: fetchUpstream,
  providerFailure: providerFailure,
  modelText: modelText,
  prepareLog: prepareLog,
  logEvent: defaultLog,
  writeLog: writeLog,
  newRequestId: newRequestId,
  securityConfig: securityConfig,
  publicRuntimeConfig: publicRuntimeConfig,
  PUBLIC_ENVIRONMENTS: PUBLIC_ENVIRONMENTS,
  accountConfig: accountConfig,
  authenticate: authenticate,
  hashIp: hashIp,
  clientIp: clientIp,
  writeJson: write,
  betaMode: betaMode,
  BETA_ADMISSION_CAP: BETA_ADMISSION_CAP,
  BETA_COHORT_MIN: BETA_COHORT_MIN,
};
