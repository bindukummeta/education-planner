"use strict";
// Security gate for the three AI routes. The fetch mock stands in for Supabase
// and Anthropic; handlers are not given a skip flag. Injected dependencies are
// used only in the cases that say so.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const security = require(path.join(__dirname, "..", "api", "security.js"));
const coach = require(path.join(__dirname, "..", "api", "coach.js"));
const practice = require(path.join(__dirname, "..", "api", "generate-practice.js"));
const analyse = require(path.join(__dirname, "..", "api", "analyse-homework.js"));

let passed = 0;
function ok(desc, cond) { assert.ok(cond, desc); passed++; }

const USER = "22222222-2222-4222-8222-222222222222";
const LEASE = "33333333-3333-4333-8333-333333333333";
const TOKEN = "Bearer aaaaaaaa.bbbbbbbb.cccccccc";
const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key-0123456789abcdef",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-0123456789abcdef",
  API_QUOTA_PEPPER: "pepper-0123456789abcdef",
  ANTHROPIC_API_KEY: "test-anthropic-key-0123456789",
};
const SNAPSHOT = { subjects: [{ subject: "Maths", recentAvg: 62 }] };
const SAMPLES = [{ questionText: "2+2", expectedAnswer: "4" }];
const ANALYSIS = {
  overall: { reasoningSummary: "Next step is addition.", confidence: 0.9 },
  attempts: [{
    questionText: "1+1",
    studentAnswer: "2",
    working: "1+1=2",
    expectedAnswer: "2",
    correctness: "correct",
    reasoningSummary: "Addition is going well.",
    confidence: 0.9,
    needsReview: false,
  }],
};

function jsonRes(status, body) {
  return { ok: status >= 200 && status < 300, status: status, json: async () => body };
}
function allowAuth() { return jsonRes(200, { id: USER, role: "authenticated" }); }
function allowQuota(lease) { return jsonRes(200, { ok: true, lease_id: lease || null }); }

function scriptFetch(behavior) {
  const calls = [];
  const impl = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts: opts });
    if (u.indexOf("/auth/v1/user") !== -1) return behavior.auth(opts);
    if (u.indexOf("/rpc/beta_access_allowed") !== -1) {
      if (behavior.beta) return behavior.beta(opts);
      return jsonRes(200, true);
    }
    if (u.indexOf("/rpc/consume_ai_quota") !== -1) return behavior.quota(opts);
    if (u.indexOf("/rpc/release_ai_concurrency") !== -1) return behavior.release(opts);
    if (u.indexOf("api.anthropic.com") !== -1) return behavior.anthropic(opts);
    throw new Error("unexpected " + u);
  };
  return { impl: impl, calls: calls };
}

function has(calls, part) { return calls.some((c) => c.url.indexOf(part) !== -1); }

async function call(handler, body, extra) {
  extra = extra || {};
  const headers = {
    authorization: extra.authorization === undefined ? TOKEN : extra.authorization,
    "x-real-ip": extra.ip || "203.0.113.10",
  };
  if (extra.authorization === null) delete headers.authorization;
  if (extra.contentLength != null) headers["content-length"] = String(extra.contentLength);
  const req = { method: extra.method || "POST", body: body, headers: headers };
  let statusCode = 0;
  let jsonBody = null;
  const sent = {};
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { jsonBody = payload; return this; },
    setHeader(key, value) { sent[String(key).toLowerCase()] = value; return this; },
  };
  await handler(req, res);
  return { statusCode: statusCode, jsonBody: jsonBody, headers: sent };
}

async function run(mod, body, behavior, extra, reqExtra) {
  const script = scriptFetch(behavior);
  const logs = [];
  const handler = mod.createHandler(Object.assign({
    env: ENV,
    fetch: script.impl,
    log: (entry) => logs.push(entry),
  }, extra || {}));
  const res = await call(handler, body, reqExtra);
  res.calls = script.calls;
  res.logs = logs;
  return res;
}

function happyAnthropic(payload) {
  return {
    auth: async () => allowAuth(),
    quota: async () => allowQuota(null),
    release: async () => jsonRes(204, null),
    anthropic: async () => jsonRes(200, payload),
  };
}

function secretFree(value) {
  const text = JSON.stringify(value);
  return text.indexOf("SECRET") === -1 &&
    text.indexOf(ENV.SUPABASE_SERVICE_ROLE_KEY) === -1 &&
    text.indexOf(ENV.ANTHROPIC_API_KEY) === -1 &&
    text.indexOf("aaaaaaaa.bbbbbbbb.cccccccc") === -1;
}

(async function () {
  const coachOk = await run(coach, { snapshot: SNAPSHOT }, happyAnthropic({ content: [{ text: "kept advice" }] }));
  ok("valid coach → 200", coachOk.statusCode === 200 && coachOk.jsonBody.advice === "kept advice");
  ok("auth uses the anon key and the user token", coachOk.calls.some((c) =>
    c.url.indexOf("/auth/v1/user") !== -1 &&
    c.opts.headers.apikey === ENV.SUPABASE_ANON_KEY &&
    c.opts.headers.authorization === TOKEN));
  const quotaCall = coachOk.calls.filter((c) => c.url.indexOf("consume_ai_quota") !== -1)[0];
  const quotaBody = JSON.parse(quotaCall.opts.body);
  ok("quota uses the service role", quotaCall.opts.headers.apikey === ENV.SUPABASE_SERVICE_ROLE_KEY);
  ok("quota is per user and per ip hash", quotaBody.p_user_id === USER && /^[a-f0-9]{32}$/.test(quotaBody.p_ip_hash));
  ok("ip hash is not the raw address", quotaBody.p_ip_hash.indexOf("203.0.113.10") === -1);
  ok("coach has no concurrency lease", quotaBody.p_concurrency_limit === 0 && quotaBody.p_lease_seconds === 0);
  ok("coach limits match the documented defaults",
    quotaBody.p_user_per_minute === security.DEFAULT_LIMITS.coach.userPerMinute &&
    quotaBody.p_user_per_day === security.DEFAULT_LIMITS.coach.userPerDay);
  const anthropic = coachOk.calls.filter((c) => c.url.indexOf("anthropic") !== -1)[0];
  ok("anthropic gets its own key and a timeout signal",
    anthropic.opts.headers["x-api-key"] === ENV.ANTHROPIC_API_KEY && anthropic.opts.signal);
  ok("valid coach log stays privacy-safe", secretFree(coachOk.logs) && secretFree(coachOk.jsonBody));

  const otherIp = await run(coach, { snapshot: SNAPSHOT }, happyAnthropic({ content: [{ text: "x" }] }), null, { ip: "198.51.100.4" });
  const otherHash = JSON.parse(otherIp.calls.filter((c) => c.url.indexOf("consume_ai_quota") !== -1)[0].opts.body).p_ip_hash;
  ok("different addresses hash differently", otherHash !== quotaBody.p_ip_hash);

  const noAuth = await run(coach, { snapshot: SNAPSHOT }, happyAnthropic({ content: [{ text: "x" }] }), null, { authorization: null });
  ok("missing token → 401", noAuth.statusCode === 401 && noAuth.jsonBody.code === "unauthorized");
  ok("missing token does not call upstream", !has(noAuth.calls, "anthropic") && !has(noAuth.calls, "consume_ai_quota"));

  const badShape = await run(coach, { snapshot: SNAPSHOT }, happyAnthropic({ content: [{ text: "x" }] }), null, { authorization: "Bearer nope" });
  ok("malformed token → 401 without a network call", badShape.statusCode === 401 && badShape.calls.length === 0);

  const rejected = await run(coach, { snapshot: SNAPSHOT }, {
    auth: async () => jsonRes(401, { message: "bad" }),
    quota: async () => allowQuota(null),
    release: async () => jsonRes(204, null),
    anthropic: async () => jsonRes(200, { content: [{ text: "x" }] }),
  });
  ok("supabase rejection → 401", rejected.statusCode === 401 && !has(rejected.calls, "anthropic"));

  const wrongRole = await run(coach, { snapshot: SNAPSHOT }, {
    auth: async () => jsonRes(200, { id: USER, role: "service_role" }),
    quota: async () => allowQuota(null),
    release: async () => jsonRes(204, null),
    anthropic: async () => jsonRes(200, {}),
  });
  ok("non-user role → 401", wrongRole.statusCode === 401 && !has(wrongRole.calls, "anthropic"));

  const serviceBearer = Object.assign({}, ENV, { SUPABASE_SERVICE_ROLE_KEY: "aaaaaaaa.bbbbbbbb.dddddddd" });
  const forged = await run(coach, { snapshot: SNAPSHOT }, happyAnthropic({ content: [{ text: "x" }] }),
    { env: serviceBearer }, { authorization: "Bearer aaaaaaaa.bbbbbbbb.dddddddd" });
  ok("service-role bearer is not a user", forged.statusCode === 401 && !has(forged.calls, "auth/v1/user"));

  const anonFlag = Object.assign({}, ENV, { AI_ALLOW_ANONYMOUS: "1" });
  const flagged = await run(coach, { snapshot: SNAPSHOT }, happyAnthropic({ content: [{ text: "x" }] }),
    { env: anonFlag }, { authorization: null });
  ok("anonymous bypass flag is ignored", flagged.statusCode === 401 && !has(flagged.calls, "anthropic"));

  const malformed = await run(coach, "{", happyAnthropic({ content: [{ text: "x" }] }));
  ok("malformed JSON → 400", malformed.statusCode === 400 && malformed.jsonBody.code === "invalid_request");
  ok("malformed JSON does not spend quota", !has(malformed.calls, "consume_ai_quota"));

  const extra = await run(coach, { snapshot: SNAPSHOT, childName: "A" }, happyAnthropic({ content: [{ text: "x" }] }));
  ok("unexpected coach field → 400", extra.statusCode === 400 && !has(extra.calls, "anthropic"));

  const oversized = await run(coach, { snapshot: { note: "x".repeat(801) } }, happyAnthropic({ content: [{ text: "x" }] }));
  ok("oversized snapshot → 413", oversized.statusCode === 413 && oversized.jsonBody.code === "payload_too_large");
  ok("oversized snapshot does not call Anthropic", !has(oversized.calls, "anthropic"));

  const hugeHeader = await run(coach, { snapshot: SNAPSHOT }, happyAnthropic({ content: [{ text: "x" }] }), null, { contentLength: 999999 });
  ok("content-length over the coach cap → 413", hugeHeader.statusCode === 413 && !has(hugeHeader.calls, "auth/v1/user"));

  const limited = await run(coach, { snapshot: SNAPSHOT }, {
    auth: async () => allowAuth(),
    quota: async () => jsonRes(200, { ok: false, reason: "user_day" }),
    release: async () => jsonRes(204, null),
    anthropic: async () => jsonRes(200, { content: [{ text: "x" }] }),
  });
  ok("rate limit → 429", limited.statusCode === 429 && limited.jsonBody.code === "rate_limited");
  ok("rate limit sets retry-after and skips Anthropic", limited.headers["retry-after"] === "60" && !has(limited.calls, "anthropic"));

  const quotaDown = await run(coach, { snapshot: SNAPSHOT }, {
    auth: async () => allowAuth(),
    quota: async () => jsonRes(500, { message: "db SECRET_QUOTA" }),
    release: async () => jsonRes(204, null),
    anthropic: async () => jsonRes(200, {}),
  });
  ok("quota outage fails closed", quotaDown.statusCode === 503 && quotaDown.jsonBody.code === "quota_unavailable");
  ok("quota outage hides the database error", secretFree(quotaDown.jsonBody) && secretFree(quotaDown.logs) && !has(quotaDown.calls, "anthropic"));

  const providerDown = await run(coach, { snapshot: SNAPSHOT }, {
    auth: async () => allowAuth(),
    quota: async () => allowQuota(null),
    release: async () => jsonRes(204, null),
    anthropic: async () => jsonRes(500, { error: { type: "api_error", message: "child wrote SECRET_ANSWER" } }),
  });
  ok("provider 500 is a generic 502", providerDown.statusCode === 502 && providerDown.jsonBody.code === "upstream_error");
  ok("provider body is logged as status/type only",
    secretFree(providerDown.jsonBody) && secretFree(providerDown.logs) &&
    providerDown.logs.some((e) => e.providerStatus === 500 && e.providerType === "api_error"));

  const timedOut = await run(coach, { snapshot: SNAPSHOT }, {
    auth: async () => allowAuth(),
    quota: async () => allowQuota(null),
    release: async () => jsonRes(204, null),
    anthropic: (opts) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(jsonRes(200, { content: [{ text: "late SECRET" }] })), 3000);
      opts.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        const err = new Error("aborted SECRET");
        err.name = "AbortError";
        reject(err);
      });
    }),
  }, { limits: { upstreamTimeoutMs: 80 } });
  ok("upstream abort → 504", timedOut.statusCode === 504 && timedOut.jsonBody.code === "timeout");
  ok("timeout response hides abort detail", secretFree(timedOut.jsonBody) && secretFree(timedOut.logs));

  const authHung = await run(coach, { snapshot: SNAPSHOT }, {
    auth: (opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    }),
    quota: async () => allowQuota(null),
    release: async () => jsonRes(204, null),
    anthropic: async () => jsonRes(200, { content: [{ text: "x" }] }),
  }, { authTimeoutMs: 80 });
  ok("auth timeout fails closed", authHung.statusCode === 503 && !has(authHung.calls, "anthropic"));

  const longQuestion = "q".repeat(2001);
  const bigSample = await run(practice, { subject: "english", samples: [{ questionText: longQuestion, expectedAnswer: "a" }] },
    happyAnthropic({ content: [{ text: "{\"questions\":[]}" }] }));
  ok("oversized practice sample → 413", bigSample.statusCode === 413 && !has(bigSample.calls, "anthropic"));

  const practiceOk = await run(practice, { subject: "english", samples: SAMPLES, count: 5 },
    happyAnthropic({ content: [{ text: JSON.stringify({ questions: [{ questionText: "3+3", expectedAnswer: "6", hint: "add" }] }) }] }));
  ok("valid practice → 200", practiceOk.statusCode === 200 && practiceOk.jsonBody.questions[0].expectedAnswer === "6");

  const image = { mediaType: "image/jpeg", data: "aaaa" };
  const analysisOk = await run(analyse, { subject: "maths", images: [image] }, {
    auth: async () => allowAuth(),
    quota: async () => allowQuota(LEASE),
    release: async () => jsonRes(204, null),
    anthropic: async () => jsonRes(200, { content: [{ text: JSON.stringify(ANALYSIS) }] }),
  });
  ok("valid analysis → 200", analysisOk.statusCode === 200 && analysisOk.jsonBody.attempts.length === 1);
  const analysisQuota = JSON.parse(analysisOk.calls.filter((c) => c.url.indexOf("consume_ai_quota") !== -1)[0].opts.body);
  ok("analysis requests one lease", analysisQuota.p_concurrency_limit === 1 && analysisQuota.p_lease_seconds === 330);
  const release = analysisOk.calls.filter((c) => c.url.indexOf("release_ai_concurrency") !== -1)[0];
  ok("analysis releases the lease", release && JSON.parse(release.opts.body).p_lease_id === LEASE);
  ok("analysis log does not contain image bytes", JSON.stringify(analysisOk.logs).indexOf("aaaa") === -1);

  const busy = await run(analyse, { subject: "maths", images: [image] }, {
    auth: async () => allowAuth(),
    quota: async () => jsonRes(200, { ok: false, reason: "concurrency" }),
    release: async () => jsonRes(204, null),
    anthropic: async () => jsonRes(200, { content: [{ text: "{}" }] }),
  });
  ok("concurrency limit → 429", busy.statusCode === 429 && busy.jsonBody.code === "concurrency_limited");
  ok("concurrency limit does not start a model call or a release", !has(busy.calls, "anthropic") && !has(busy.calls, "release_ai_concurrency"));

  const tooMany = await run(analyse, {
    subject: "maths",
    images: [image, image, image, image, image, image, image, image, image],
  }, {
    auth: async () => allowAuth(),
    quota: async () => allowQuota(LEASE),
    release: async () => jsonRes(204, null),
    anthropic: async () => jsonRes(200, {}),
  });
  ok("more than 8 images → 413", tooMany.statusCode === 413 && !has(tooMany.calls, "anthropic"));

  const gif = await run(analyse, { subject: "maths", images: [{ mediaType: "image/gif", data: "aaaa" }] }, {
    auth: async () => allowAuth(),
    quota: async () => allowQuota(LEASE),
    release: async () => jsonRes(204, null),
    anthropic: async () => jsonRes(200, {}),
  });
  ok("unsupported image type → 400", gif.statusCode === 400 && gif.jsonBody.code === "invalid_request");

  const blew = await run(analyse, { subject: "maths", images: [image] }, {
    auth: async () => allowAuth(),
    quota: async () => allowQuota(LEASE),
    release: async () => jsonRes(204, null),
    anthropic: async () => { const err = new Error("socket SECRET_IMAGE"); err.name = "TypeError"; throw err; },
  });
  ok("upstream throw is generic and still releases", blew.statusCode === 502 && secretFree(blew.jsonBody) && secretFree(blew.logs));
  ok("lease released after upstream throw", has(blew.calls, "release_ai_concurrency"));

  let partialCalled = false;
  const partial = coach.createHandler({
    env: ENV,
    verifyAccessToken: async () => { partialCalled = true; return { userId: USER }; },
    consumeQuota: async () => ({ ok: true }),
    fetch: async () => { throw new Error("should not fetch"); },
    log: () => {},
  });
  const partialRes = await call(partial, { snapshot: SNAPSHOT });
  ok("partial injection fails closed", partialRes.statusCode === 503 && partialRes.jsonBody.code === "not_configured" && partialCalled === false);

  const saved = {};
  security.REQUIRED_ENV.forEach((key) => { saved[key] = process.env[key]; process.env[key] = ""; });
  const origFetch = global.fetch;
  let defaultFetched = false;
  global.fetch = async () => { defaultFetched = true; throw new Error("network"); };
  try {
    const closed = await call(coach, { snapshot: SNAPSHOT });
    ok("production export fails closed without security env", closed.statusCode === 503 && closed.jsonBody.code === "not_configured");
    ok("fail-closed response does not name env vars", JSON.stringify(closed.jsonBody).indexOf("SUPABASE") === -1);
    ok("fail-closed path does not call fetch", defaultFetched === false);
  } finally {
    global.fetch = origFetch;
    security.REQUIRED_ENV.forEach((key) => {
      if (saved[key] == null) delete process.env[key];
      else process.env[key] = saved[key];
    });
  }

  const sameKey = Object.assign({}, ENV, { SUPABASE_SERVICE_ROLE_KEY: ENV.SUPABASE_ANON_KEY });
  const same = await run(coach, { snapshot: SNAPSHOT }, happyAnthropic({ content: [{ text: "x" }] }), { env: sameKey });
  ok("identical anon and service keys fail closed", same.statusCode === 503 && same.calls.length === 0);

  const readme = fs.readFileSync(path.join(__dirname, "..", "api", "README.md"), "utf8");
  security.REQUIRED_ENV.forEach((key) => ok("readme documents " + key, readme.indexOf(key) !== -1));
  ok("readme documents coach minute default", readme.indexOf("AI_QUOTA_COACH_USER_PER_MINUTE") !== -1 &&
    readme.indexOf("| " + security.DEFAULT_LIMITS.coach.userPerMinute) !== -1);
  ok("readme documents analysis concurrency", readme.indexOf("AI_QUOTA_ANALYSE_HOMEWORK_CONCURRENCY") !== -1 &&
    readme.indexOf("| " + security.DEFAULT_LIMITS["analyse-homework"].concurrency) !== -1);
  ok("readme documents the 8 image cap", readme.indexOf("8 images") !== -1);

  const sql = fs.readFileSync(path.join(__dirname, "..", "supabase", "2026-ai-api-quotas.sql"), "utf8");
  ok("quota migration defines consume and release", sql.indexOf("consume_ai_quota") !== -1 && sql.indexOf("release_ai_concurrency") !== -1);
  ok("quota migration is security definer", sql.indexOf("security definer") !== -1);
  ok("quota migration revokes browser roles", sql.indexOf("from public, anon, authenticated") !== -1);
  ok("quota helpers are not granted to the service role", sql.indexOf("grant execute on function public.ai_quota_take") === -1);
  ok("quota migration serializes a user's lease", sql.indexOf("pg_advisory_xact_lock") !== -1);
  ok("quota functions require service_role and keep the grants", sql.indexOf("auth.role()") !== -1 && sql.indexOf("service_role") !== -1 && sql.indexOf("from public, anon, authenticated") !== -1 && sql.indexOf("grant execute on function public.consume_ai_quota") !== -1 && sql.indexOf("grant execute on function public.ai_quota_take") === -1);
  const pepper = ENV.API_QUOTA_PEPPER;
  const hash = (headers) => security.hashIp({ API_QUOTA_PEPPER: pepper }, { headers: headers });
  ok("vercel rightmost address beats a caller-prepended forwarding hop",
    hash({ "x-vercel-forwarded-for": "8.8.8.8, 203.0.113.50", "x-forwarded-for": "1.1.1.1", "x-real-ip": "9.9.9.9" }) === hash({ "x-vercel-forwarded-for": "203.0.113.50" }));
  ok("the first x-forwarded-for hop is not the quota address",
    hash({ "x-forwarded-for": "8.8.8.8, 203.0.113.50" }) === hash({ "x-real-ip": "203.0.113.50" }));
  ok("an invalid address does not become a bucket key", security.clientIp({ headers: { "x-forwarded-for": "not-an-ip, also-bad" } }) === "unknown");
  ok("a missing pepper is not hashed with a public fallback", security.hashIp({}, { headers: { "x-real-ip": "203.0.113.10" } }) === null && security.hashIp({ API_QUOTA_PEPPER: "short" }, { headers: {} }) === null);
  const securitySrc = fs.readFileSync(path.join(__dirname, "..", "api", "security.js"), "utf8");
  ok("security module has no in-memory counter", securitySrc.indexOf("new Map") === -1 && securitySrc.indexOf("consume_ai_quota") !== -1);

  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  ["/api/coach", "/api/analyse-homework", "/api/generate-practice"].forEach((route) => {
    const at = app.indexOf('fetch("' + route + '"');
    const slice = app.slice(Math.max(0, at - 220), at + 280);
    ok(route + " sends the access token", at !== -1 && slice.indexOf("aiAuthHeaders") !== -1);
  });
  ok("signed-out client error is specific", app.indexOf("Sign in is required. Open Settings, use Family Sync to sign in") !== -1);

  console.log("api-security.test.js: " + passed + " assertions passed");
})().catch((err) => { console.error(err); process.exit(1); });
