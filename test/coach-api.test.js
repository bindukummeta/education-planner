"use strict";
// Integration test for the /api/coach serverless handler. Mocks global.fetch so
// nothing hits the network, and asserts the audience branching picks the right
// prompt (parent path unchanged; child path uses the kid-safe prompt) plus the
// request-validation paths. No DOM/vm slice needed — coach.js is plain Node.
const assert = require("assert"), path = require("path");

process.env.ANTHROPIC_API_KEY = "test-key";
delete process.env.ANTHROPIC_COACH_MODEL;
const handler = require(path.join(__dirname, "..", "api", "coach.js"));

let passed = 0;
function ok(d, c) { assert.ok(c, d); passed++; }

const SNAPSHOT = {
  subjects: [{ subject: "Maths", recentAvg: 62 }],
  schools: [], reading: { weekMinutes: 90, books: 2 }, mocks: [],
};

// Invoke the handler with a fake req/res, capturing the outbound Anthropic call.
async function invoke(body, method) {
  let captured = null;
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    captured = { url, prompt: JSON.parse(opts.body).messages[0].content, model: JSON.parse(opts.body).model };
    return { ok: true, status: 200, json: async () => ({ content: [{ text: "ok advice" }] }) };
  };
  const req = { method: method || "POST", body };
  let statusCode = null, jsonBody = null;
  const res = { status(c) { statusCode = c; return this; }, json(b) { jsonBody = b; return this; } };
  try { await handler(req, res); } finally { global.fetch = orig; }
  return { statusCode, jsonBody, captured };
}

(async function () {
  const snapJSON = JSON.stringify(SNAPSHOT, null, 2);

  // Parent (no audience) → parent prompt, unchanged shape.
  const p = await invoke({ snapshot: SNAPSHOT });
  ok("parent status 200", p.statusCode === 200);
  ok("parent advice returned", p.jsonBody.advice === "ok advice");
  ok("parent prompt is parent-facing", p.captured.prompt.indexOf("advising a parent") >= 0);
  ok("parent prompt has no child framing", p.captured.prompt.indexOf("writing DIRECTLY to a child") < 0);
  ok("parent prompt embeds snapshot", p.captured.prompt.indexOf(snapJSON) >= 0);
  ok("default model used", p.captured.model === "claude-sonnet-5");

  // Child audience → kid-safe prompt with the banned-word rules.
  const c = await invoke({ snapshot: SNAPSHOT, audience: "child" });
  ok("child status 200", c.statusCode === 200);
  ok("child prompt is child-facing", c.captured.prompt.indexOf("writing DIRECTLY to a child") >= 0);
  ok("child prompt forbids deficit words", c.captured.prompt.indexOf("Never use deficit") >= 0);
  ok("child prompt bans comparisons", c.captured.prompt.indexOf("never") >= 0 && c.captured.prompt.indexOf("weakest") >= 0);
  ok("child prompt is not the parent prompt", c.captured.prompt.indexOf("advising a parent") < 0);
  ok("child prompt embeds snapshot", c.captured.prompt.indexOf(snapJSON) >= 0);

  // Unknown audience value falls back to the parent prompt.
  const t = await invoke({ snapshot: SNAPSHOT, audience: "teen" });
  ok("unknown audience → parent prompt", t.captured.prompt.indexOf("advising a parent") >= 0);

  // Missing snapshot → 400, no network call.
  const m = await invoke({});
  ok("missing snapshot → 400", m.statusCode === 400);
  ok("missing snapshot did not call fetch", m.captured === null);

  // Non-POST → 405, no network call.
  const g = await invoke({ snapshot: SNAPSHOT }, "GET");
  ok("GET → 405", g.statusCode === 405);
  ok("GET did not call fetch", g.captured === null);

  console.log("coach-api.test.js: " + passed + " assertions passed");
})().catch((err) => { console.error(err); process.exit(1); });
