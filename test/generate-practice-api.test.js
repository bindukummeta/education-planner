"use strict";
// Integration test for the /api/generate-practice serverless handler. Mocks
// global.fetch so nothing hits the network, and asserts the request shaping
// (subject/topic/error/samples embedded in the prompt), the Structured-Outputs
// options, response normalization, and the validation paths. No DOM/vm slice —
// generate-practice.js is plain Node.
const assert = require("assert"), path = require("path");

process.env.ANTHROPIC_API_KEY = "test-key";
delete process.env.ANTHROPIC_PRACTICE_MODEL;
const handler = require(path.join(__dirname, "..", "api", "generate-practice.js"));

let passed = 0;
function ok(d, c) { assert.ok(c, d); passed++; }

const SAMPLES = [
  { questionText: "What is the plural of 'child'?", expectedAnswer: "children" },
  { questionText: "Give the past tense of 'run'.", expectedAnswer: "ran" },
];
const REPLY = {
  questions: [
    { questionText: "What is the plural of 'mouse'?", expectedAnswer: "mice", hint: "Think small and furry." },
    { questionText: "Past tense of 'swim'?", expectedAnswer: "swam", hint: "It rhymes with 'ram'." },
    { questionText: "  ", expectedAnswer: "x", hint: "dropped — no question text" },
  ],
};

// Invoke the handler with a fake req/res, capturing the outbound Anthropic call.
async function invoke(body, method, reply) {
  let captured = null;
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    const parsed = JSON.parse(opts.body);
    captured = {
      url,
      prompt: parsed.messages[0].content,
      model: parsed.model,
      thinking: parsed.thinking,
      format: parsed.output_config && parsed.output_config.format,
      system: parsed.system,
    };
    return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify(reply || REPLY) }] }) };
  };
  const req = { method: method || "POST", body };
  let statusCode = null, jsonBody = null;
  const res = { status(c) { statusCode = c; return this; }, json(b) { jsonBody = b; return this; } };
  try { await handler(req, res); } finally { global.fetch = orig; }
  return { statusCode, jsonBody, captured };
}

(async function () {
  // Happy path → 200, normalized questions, request shaped correctly.
  const r = await invoke({
    subject: "english", topic: "grammar", errorType: "spelling",
    samples: SAMPLES, count: 5,
  });
  ok("status 200", r.statusCode === 200);
  ok("returns questions array", Array.isArray(r.jsonBody.questions));
  ok("drops blank-question entries", r.jsonBody.questions.length === 2);
  ok("keeps questionText", r.jsonBody.questions[0].questionText === "What is the plural of 'mouse'?");
  ok("keeps expectedAnswer", r.jsonBody.questions[0].expectedAnswer === "mice");
  ok("keeps hint", r.jsonBody.questions[0].hint === "Think small and furry.");

  // Request shaping: prompt carries the derived context and the samples.
  ok("prompt has subject", r.captured.prompt.indexOf("english") >= 0);
  ok("prompt has topic", r.captured.prompt.indexOf("grammar") >= 0);
  ok("prompt has errorType", r.captured.prompt.indexOf("spelling") >= 0);
  ok("prompt embeds a sample question", r.captured.prompt.indexOf("plural of 'child'") >= 0);
  ok("prompt embeds a sample answer", r.captured.prompt.indexOf("children") >= 0);
  ok("default model used", r.captured.model === "claude-sonnet-5");
  ok("thinking disabled", r.captured.thinking && r.captured.thinking.type === "disabled");
  ok("structured output json_schema", r.captured.format && r.captured.format.type === "json_schema");
  ok("schema requires questions", r.captured.format.schema.required.indexOf("questions") >= 0);

  // System prompt keeps the kid-safe, no-copy, short-answer rules.
  ok("system forbids deficit words", r.captured.system.indexOf("deficit") >= 0);
  ok("system says do NOT copy", r.captured.system.indexOf("do NOT copy") >= 0);

  // count is clamped to MAX_COUNT (8).
  const big = await invoke({ subject: "english", samples: SAMPLES, count: 99 });
  ok("count clamped in prompt", big.captured.prompt.indexOf("write: 8") >= 0);

  // Missing samples → 400, no network call.
  const noSamples = await invoke({ subject: "english", samples: [] });
  ok("missing samples → 400", noSamples.statusCode === 400);
  ok("missing samples did not call fetch", noSamples.captured === null);

  // Samples with only blank text → 400.
  const blankSamples = await invoke({ subject: "english", samples: [{ questionText: "   " }] });
  ok("blank samples → 400", blankSamples.statusCode === 400);

  // Invalid body → 400.
  const bad = await invoke(null);
  ok("null body → 400", bad.statusCode === 400);

  // Non-POST → 405, no network call.
  const g = await invoke({ subject: "english", samples: SAMPLES }, "GET");
  ok("GET → 405", g.statusCode === 405);
  ok("GET did not call fetch", g.captured === null);

  // Upstream returns unusable JSON → 502.
  const unusable = await invoke({ subject: "english", samples: SAMPLES }, "POST",
    { questions: [{ questionText: "", expectedAnswer: "" }] });
  ok("no usable questions → 502", unusable.statusCode === 502);

  console.log("generate-practice-api.test.js: " + passed + " assertions passed");
})().catch((err) => { console.error(err); process.exit(1); });
