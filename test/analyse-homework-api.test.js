"use strict";
// Handler tests for /api/analyse-homework. Auth, quotas, and the upstream
// call are injected or forced closed so nothing leaves the process.
const assert = require("assert");
const path = require("path");

const security = require(path.join(__dirname, "..", "api", "security.js"));
const { createHandler } = require(path.join(__dirname, "..", "api", "analyse-homework.js"));
const analyse = require(path.join(__dirname, "..", "api", "analyse-homework.js"));

let passed = 0;
function ok(desc, cond) { assert.ok(cond, desc); passed++; }

const USER = "11111111-1111-4111-8111-111111111111";
const LEASE = "44444444-4444-4444-8444-444444444444";
const TOKEN = "Bearer aaaaaaaa.bbbbbbbb.cccccccc";
const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key-0123456789abcdef",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-0123456789abcdef",
  API_QUOTA_PEPPER: "pepper-0123456789abcdef",
  ANTHROPIC_API_KEY: "test-anthropic-key-0123456789",
  ANTHROPIC_VISION_MODEL: "claude-sonnet-test",
};
const JPEG = { mediaType: "image/jpeg", data: "SMOK" };
const PNG = { mediaType: "image/png", data: "SMO2" };

const MODEL = {
  overall: { reasoningSummary: "  Practise addition next.  ", confidence: 2 },
  attempts: [
    {
      questionText: "  12 + 9  ",
      studentAnswer: "  20 ",
      working: "  12+9=21 ",
      expectedAnswer: "  21 ",
      correctness: "incorrect",
      marksAwarded: 0,
      marksAvailable: 2,
      errorType: "calculation",
      subskill: " column addition ",
      topic: " addition ",
      reasoningSummary: " Adding tens is the next step. ",
      confidence: 0.84,
      needsReview: false,
    },
    {
      questionText: "7+1",
      studentAnswer: " ",
      working: "",
      expectedAnswer: null,
      correctness: "correct",
      errorType: "nope",
      marksAwarded: "1",
      marksAvailable: "nope",
      subskill: " ",
      topic: null,
      reasoningSummary: 5,
      confidence: 0.5,
      needsReview: false,
    },
    {
      questionText: "9+9",
      studentAnswer: "18",
      working: "9+9=18",
      expectedAnswer: "18",
      correctness: "correct",
      errorType: null,
      reasoningSummary: "Matched.",
      confidence: 0.95,
      needsReview: true,
    },
    "not-an-attempt",
  ],
};

function secretFree(value) {
  const text = JSON.stringify(value);
  return text.indexOf("SECRET") === -1 &&
    text.indexOf("SMOK") === -1 &&
    text.indexOf("SMO2") === -1 &&
    text.indexOf(ENV.ANTHROPIC_API_KEY) === -1 &&
    text.indexOf("aaaaaaaa.bbbbbbbb.cccccccc") === -1;
}

function call(handler, body, extra) {
  extra = extra || {};
  const headers = { authorization: extra.authorization === undefined ? TOKEN : extra.authorization };
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
  return handler(req, res).then(() => ({ statusCode: statusCode, jsonBody: jsonBody, headers: sent }));
}

function invoke(body, options) {
  options = options || {};
  const calls = { upstream: null, quota: 0, release: [], verify: 0 };
  const logs = [];
  const fetchImpl = async (url, opts) => {
    const parsed = JSON.parse(opts.body);
    calls.upstream = { url: String(url), body: parsed, signal: opts.signal, headers: opts.headers };
    if (options.upstream === "timeout") {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({
          ok: true,
          status: 200,
          json: async () => ({ content: [{ text: "late SECRET" }] }),
        }), 5000);
        opts.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          const err = new Error("aborted SECRET");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    if (options.upstream === "throw") {
      const err = new Error("socket SECRET_IMAGE");
      err.name = "TypeError";
      throw err;
    }
    if (options.upstream === "http") {
      return {
        ok: false,
        status: 529,
        json: async () => ({ error: { type: "api_error", message: "SECRET_WORKSHEET" } }),
      };
    }
    const text = options.modelText != null ? options.modelText : JSON.stringify(options.model || MODEL);
    return { ok: true, status: 200, json: async () => ({ content: [{ text: text }], stop_reason: "end_turn" }) };
  };
  const handler = createHandler({
    env: Object.assign({}, ENV, options.env || {}),
    fetch: fetchImpl,
    limits: options.limits,
    log: (entry) => logs.push(entry),
    verifyAccessToken: async () => {
      calls.verify += 1;
      if (options.auth === "reject") return null;
      if (options.auth === "bad-id") return { userId: "not-a-uuid" };
      if (options.auth === "timeout") {
        const err = new Error("auth hung");
        err.code = "timeout";
        err.errorName = "AbortError";
        throw err;
      }
      return { userId: USER };
    },
    consumeQuota: async () => {
      calls.quota += 1;
      if (options.quota === "rate") return { ok: false, reason: "user_minute" };
      if (options.quota === "concurrency") return { ok: false, reason: "concurrency" };
      if (options.quota === "down") {
        const err = new Error("db SECRET_QUOTA");
        err.errorName = "PostgrestError";
        throw err;
      }
      return { ok: true, leaseId: LEASE };
    },
    releaseConcurrency: async (id) => { calls.release.push(id); },
  });
  return call(handler, body, options.req).then((res) => {
    res.calls = calls;
    res.logs = logs;
    return res;
  });
}

const validBody = { subject: "  maths ", images: [JPEG, PNG] };

(async function () {
  const okRes = await invoke(validBody);
  ok("valid analysis → 200", okRes.statusCode === 200);
  assert.deepStrictEqual(okRes.jsonBody, {
    provider: "anthropic",
    model: "claude-sonnet-test",
    subject: "maths",
    overall: { reasoningSummary: "Practise addition next.", confidence: 1 },
    attempts: [
      {
        questionText: "12 + 9",
        studentAnswer: "20",
        working: "12+9=21",
        expectedAnswer: "21",
        correctness: "incorrect",
        marksAwarded: 0,
        marksAvailable: 2,
        errorType: "calculation",
        subskill: "column addition",
        topic: "addition",
        reasoningSummary: "Adding tens is the next step.",
        confidence: 0.84,
        needsReview: false,
      },
      {
        questionText: "7+1",
        studentAnswer: null,
        working: null,
        expectedAnswer: null,
        correctness: "correct",
        marksAwarded: null,
        marksAvailable: null,
        errorType: null,
        subskill: null,
        topic: null,
        reasoningSummary: "",
        confidence: 0.5,
        needsReview: true,
      },
      {
        questionText: "9+9",
        studentAnswer: "18",
        working: "9+9=18",
        expectedAnswer: "18",
        correctness: "correct",
        marksAwarded: null,
        marksAvailable: null,
        errorType: null,
        subskill: null,
        topic: null,
        reasoningSummary: "Matched.",
        confidence: 0.95,
        needsReview: true,
      },
      {
        questionText: "",
        studentAnswer: null,
        working: null,
        expectedAnswer: null,
        correctness: "unclear",
        marksAwarded: null,
        marksAvailable: null,
        errorType: null,
        subskill: null,
        topic: null,
        reasoningSummary: "",
        confidence: null,
        needsReview: true,
      },
    ],
  });
  passed++;
  ok("normalized body hides image bytes and the api key", secretFree(okRes.jsonBody) && secretFree(okRes.logs));
  ok("success releases the analysis lease", okRes.calls.release.length === 1 && okRes.calls.release[0] === LEASE);
  const up = okRes.calls.upstream;
  ok("upstream url is the Anthropic messages endpoint", up && up.url === security.ANTHROPIC_URL);
  ok("vision model and api key are sent upstream",
    up.body.model === "claude-sonnet-test" && up.headers["x-api-key"] === ENV.ANTHROPIC_API_KEY);
  ok("adaptive thinking and json schema are requested",
    up.body.thinking && up.body.thinking.type === "adaptive" &&
    up.body.output_config.format.type === "json_schema" &&
    up.body.output_config.effort === (process.env.ANTHROPIC_EFFORT || "medium"));
  ok("both pages are images followed by the subject prompt",
    up.body.messages[0].content.length === 3 &&
    up.body.messages[0].content[0].source.data === "SMOK" &&
    up.body.messages[0].content[1].source.media_type === "image/png" &&
    up.body.messages[0].content[2].text.indexOf("maths") !== -1 &&
    up.body.messages[0].content[2].text.indexOf("2 photos") !== -1);
  ok("upstream call has a timeout signal", up.signal && typeof up.signal.aborted === "boolean");

  const fenced = await invoke(
    { subject: "maths", image: JPEG },
    { modelText: "```json\n" + JSON.stringify({ overall: { reasoningSummary: "Fine.", confidence: 0.9 }, attempts: [] }) + "\n```" }
  );
  ok("legacy image field and fenced json normalize",
    fenced.statusCode === 200 && fenced.jsonBody.attempts.length === 0 &&
    fenced.jsonBody.overall.reasoningSummary === "Fine." &&
    fenced.calls.upstream.body.messages[0].content.length === 2);

  const noAuth = await invoke(validBody, { req: { authorization: null } });
  ok("missing token → 401", noAuth.statusCode === 401 && noAuth.jsonBody.code === "unauthorized");
  ok("missing token does not verify, spend quota, or call the model",
    noAuth.calls.verify === 0 && noAuth.calls.quota === 0 && noAuth.calls.upstream === null);

  const badToken = await invoke(validBody, { req: { authorization: "Bearer nope" } });
  ok("malformed token → 401 without verify", badToken.statusCode === 401 && badToken.calls.verify === 0);

  const rejected = await invoke(validBody, { auth: "reject" });
  ok("rejected session → 401", rejected.statusCode === 401 && rejected.calls.quota === 0 && rejected.calls.upstream === null);

  const badId = await invoke(validBody, { auth: "bad-id" });
  ok("non-uuid user → 401", badId.statusCode === 401 && badId.calls.upstream === null);

  const authTimeout = await invoke(validBody, { auth: "timeout" });
  ok("auth timeout fails closed", authTimeout.statusCode === 503 && authTimeout.calls.upstream === null && secretFree(authTimeout.jsonBody));

  const malformed = await invoke("{");
  ok("malformed JSON → 400", malformed.statusCode === 400 && malformed.jsonBody.code === "invalid_request");
  ok("malformed JSON does not spend quota", malformed.calls.quota === 0 && malformed.calls.upstream === null);

  const extra = await invoke({ subject: "maths", images: [JPEG], childName: "A" });
  ok("unexpected field → 400", extra.statusCode === 400 && extra.calls.quota === 0);

  const empty = await invoke({ subject: "maths", images: [] });
  ok("no images → 400", empty.statusCode === 400 && empty.jsonBody.code === "invalid_request");

  const gif = await invoke({ subject: "maths", images: [{ mediaType: "image/gif", data: "SMOK" }] });
  ok("unsupported media → 400", gif.statusCode === 400 && gif.calls.upstream === null);

  const badB64 = await invoke({ subject: "maths", images: [{ mediaType: "image/jpeg", data: "abc" }] });
  ok("malformed image bytes → 400", badB64.statusCode === 400 && badB64.calls.quota === 0);

  const nine = [JPEG, JPEG, JPEG, JPEG, JPEG, JPEG, JPEG, JPEG, JPEG];
  const tooMany = await invoke({ subject: "maths", images: nine });
  ok("more than 8 images → 413", tooMany.statusCode === 413 && tooMany.jsonBody.code === "payload_too_large");
  ok("image-count rejection skips quota and the model", tooMany.calls.quota === 0 && tooMany.calls.upstream === null);

  const eight = await invoke({ subject: "maths", images: nine.slice(0, 8) });
  ok("8 images are accepted", eight.statusCode === 200 && eight.calls.upstream.body.messages[0].content.length === 9);

  const huge = await invoke({ subject: "maths", images: [JPEG, PNG] }, { limits: { maxDecodedBytes: 4 } });
  ok("decoded image total over the cap → 413", huge.statusCode === 413 && huge.calls.upstream === null && huge.calls.quota === 0);

  const headerCap = await invoke(validBody, { req: { contentLength: security.DEFAULT_LIMITS["analyse-homework"].maxBodyChars + 1 } });
  ok("content-length over the cap → 413 before auth",
    headerCap.statusCode === 413 && headerCap.calls.verify === 0 && headerCap.calls.upstream === null);

  const rate = await invoke(validBody, { quota: "rate" });
  ok("quota window → 429", rate.statusCode === 429 && rate.jsonBody.code === "rate_limited" && rate.headers["retry-after"] === "60");
  ok("rate limit does not call the model or release a lease", rate.calls.upstream === null && rate.calls.release.length === 0);

  const busy = await invoke(validBody, { quota: "concurrency" });
  ok("concurrency lease held → 429", busy.statusCode === 429 && busy.jsonBody.code === "concurrency_limited");
  ok("concurrency rejection does not start the model", busy.calls.upstream === null && busy.calls.release.length === 0);

  const quotaDown = await invoke(validBody, { quota: "down" });
  ok("quota outage → 503", quotaDown.statusCode === 503 && quotaDown.jsonBody.code === "quota_unavailable");
  ok("quota outage hides the database error", secretFree(quotaDown.jsonBody) && secretFree(quotaDown.logs) && quotaDown.calls.upstream === null);

  const timedOut = await invoke(validBody, { upstream: "timeout", limits: { upstreamTimeoutMs: 80 } });
  ok("upstream abort → 504", timedOut.statusCode === 504 && timedOut.jsonBody.code === "timeout");
  ok("timeout hides abort detail and releases the lease",
    secretFree(timedOut.jsonBody) && secretFree(timedOut.logs) && timedOut.calls.release[0] === LEASE);

  const provider = await invoke(validBody, { upstream: "http" });
  ok("provider error → 502", provider.statusCode === 502 && provider.jsonBody.code === "upstream_error");
  ok("provider body is status and type only",
    secretFree(provider.jsonBody) && secretFree(provider.logs) &&
    provider.logs.some((entry) => entry.providerStatus === 529 && entry.providerType === "api_error") &&
    provider.calls.release[0] === LEASE);

  const emptyText = await invoke(validBody, { modelText: "   " });
  ok("empty model text → 502", emptyText.statusCode === 502 && emptyText.calls.release[0] === LEASE);

  const badJson = await invoke(validBody, { modelText: "not-json" });
  ok("unparseable model text → 502", badJson.statusCode === 502 && badJson.jsonBody.code === "upstream_error" && secretFree(badJson.jsonBody));

  const blown = await invoke(validBody, { upstream: "throw" });
  ok("provider throw → 502 and still releases",
    blown.statusCode === 502 && blown.calls.release[0] === LEASE && secretFree(blown.jsonBody) && secretFree(blown.logs));

  const get = await invoke(validBody, { req: { method: "GET" } });
  ok("GET → 405", get.statusCode === 405 && get.calls.verify === 0);

  const saved = {};
  let fetched = false;
  const origFetch = global.fetch;
  security.REQUIRED_ENV.forEach((key) => { saved[key] = process.env[key]; process.env[key] = ""; });
  global.fetch = async () => { fetched = true; throw new Error("network SECRET"); };
  try {
    const closed = await call(analyse, validBody);
    ok("production handler fails closed without security env", closed.statusCode === 503 && closed.jsonBody.code === "not_configured");
    ok("fail-closed response does not call fetch or name env vars",
      fetched === false && JSON.stringify(closed.jsonBody).indexOf("SUPABASE") === -1 && secretFree(closed.jsonBody));
  } finally {
    global.fetch = origFetch;
    security.REQUIRED_ENV.forEach((key) => {
      if (saved[key] == null) delete process.env[key];
      else process.env[key] = saved[key];
    });
  }

  console.log("analyse-homework-api.test.js: " + passed + " assertions passed");
})().catch((err) => { console.error(err); process.exit(1); });
