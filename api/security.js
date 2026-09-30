"use strict";
// Shared gate for the AI routes: Supabase bearer auth, body limits, and
// distributed quotas. Production always calls Supabase. Tests pass deps
// (env, fetch, or verifyAccessToken + consumeQuota + releaseConcurrency)
// explicitly. There is no anonymous bypass flag.

const crypto = require("crypto");

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
  quota_unavailable: { status: 503, error: "This feature is temporarily unavailable." },
  method_not_allowed: { status: 405, error: "Use POST." },
  internal: { status: 500, error: "Something went wrong. Please try again." },
};

const LOG_KEYS = [
  "requestId", "endpoint", "outcome", "httpStatus", "durationMs",
  "userHash", "ipHash", "providerStatus", "providerType", "stopReason",
  "missing", "errorName", "releaseFailed",
];

const RATE_REASONS = { user_minute: 1, user_day: 1, ip_minute: 1, ip_day: 1 };

function defaultLog(entry) {
  const safe = { ts: new Date().toISOString() };
  LOG_KEYS.forEach((key) => {
    if (entry && entry[key] != null) safe[key] = entry[key];
  });
  console.log(JSON.stringify(safe));
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

function clientIp(req) {
  const real = header(req, "x-real-ip");
  if (typeof real === "string" && real.trim()) return real.trim().slice(0, 80);
  const forwarded = header(req, "x-forwarded-for");
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim().slice(0, 80) || "unknown";
  }
  return "unknown";
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
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
  res.status(status).json(payload);
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

async function protect(req, res, endpoint, deps) {
  const started = Date.now();
  const requestId = crypto.randomBytes(8).toString("hex");
  const log = deps && typeof deps.log === "function" ? deps.log : defaultLog;
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

module.exports = {
  ANTHROPIC_URL: ANTHROPIC_URL,
  REQUIRED_ENV: REQUIRED_ENV,
  DEFAULT_LIMITS: DEFAULT_LIMITS,
  PUBLIC_ERRORS: PUBLIC_ERRORS,
  protect: protect,
  fetchUpstream: fetchUpstream,
  providerFailure: providerFailure,
  modelText: modelText,
};
