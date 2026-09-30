// api/generate-practice.js
// Enhanced AI (opt-in) practice generation. Given a few of a child's OWN wrong
// questions (derived text only — never photos, names, or notes), ask Claude for
// fresh, self-contained, auto-checkable questions of the SAME skill so the child
// can practise the exact blind spot. Mirrors api/coach.js conventions: text-only
// POST, ANTHROPIC_API_KEY from env, Structured Outputs for guaranteed-valid JSON.
const security = require("./security");
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_OUTPUT_TOKENS = Number(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS) || 4000;

// Structured Outputs schema — the reply is guaranteed to match this shape.
const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          questionText: { type: "string" },
          expectedAnswer: { type: "string" },
          hint: { type: "string" }
        },
        required: ["questionText", "expectedAnswer", "hint"]
      }
    }
  },
  required: ["questions"]
};

const SYSTEM_PROMPT = [
  "You write fresh practice questions for a child of about ten (UK 11+ level).",
  "You are given a few examples of questions the child recently got wrong, plus",
  "the subject, topic, and the kind of mistake. Generate NEW questions that",
  "practise the SAME skill at the SAME difficulty — do NOT copy the examples,",
  "and do NOT reuse their exact numbers or wording. Each question must be:",
  "- self-contained (answerable without any missing image, passage, or context);",
  "- unambiguous, with ONE short correct answer a child can type;",
  "- age-appropriate, warm, and never scary or upsetting.",
  "For expectedAnswer give the shortest exact answer (a word, number, or short",
  "phrase) — no full sentences, no explanation. For hint give a brief, encouraging",
  "nudge that does NOT give the answer away. Never use deficit or ability words",
  "(weak, bad, poor, behind, failing, stupid, etc.). Reply with ONLY the JSON",
  "described by your output schema."
].join("\n");

function buildUserPrompt(subject, topic, errorType, samples, count) {
  const lines = [
    "Subject: " + (subject || "general"),
    "Topic: " + (topic || "general"),
    "Kind of mistake: " + (errorType || "unspecified"),
    "Number of NEW questions to write: " + count,
    "",
    "Examples the child got wrong (for skill/difficulty reference only — do not copy):"
  ];
  samples.forEach((s, i) => {
    lines.push((i + 1) + ". " + s.questionText +
      (s.expectedAnswer ? "  [correct answer: " + s.expectedAnswer + "]" : ""));
  });
  return lines.join("\n");
}

function strOrEmpty(s) { return typeof s === "string" && s.trim() ? s.trim() : ""; }

function normalizeQuestions(raw, count) {
  const arr = Array.isArray(raw && raw.questions) ? raw.questions : [];
  return arr
    .map((q) => ({
      questionText: strOrEmpty(q && q.questionText),
      expectedAnswer: strOrEmpty(q && q.expectedAnswer),
      hint: strOrEmpty(q && q.hint)
    }))
    .filter((q) => q.questionText && q.expectedAnswer)
    .slice(0, count);
}

async function handle(req, res, deps) {
  const gate = await security.protect(req, res, "generate-practice", deps);
  if (!gate.ok) return;
  try {
    const apiKey = String(gate.env.ANTHROPIC_API_KEY || "").trim();
    const model = gate.env.ANTHROPIC_PRACTICE_MODEL || DEFAULT_MODEL;
    const body = gate.body;
    const upstream = await security.fetchUpstream(security.ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        // Structured extraction, not deep reasoning — reserve the whole budget
        // for the output so the JSON is never truncated by thinking tokens.
        thinking: { type: "disabled" },
        output_config: { format: { type: "json_schema", schema: RESPONSE_SCHEMA } },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(body.subject, body.topic, body.errorType, body.samples, body.count) }]
      })
    }, gate.timeoutMs, gate.fetch);
    if (!upstream.ok) {
      const failure = await security.providerFailure(upstream);
      return gate.fail("upstream_error", failure);
    }
    const data = await upstream.json();
    let parsed = null;
    try { parsed = JSON.parse(security.modelText(data)); } catch (_) { parsed = null; }
    const questions = parsed ? normalizeQuestions(parsed, body.count) : [];
    if (!questions.length) return gate.fail("upstream_error", { providerStatus: upstream.status, stopReason: data && data.stop_reason });
    gate.succeed({ providerStatus: upstream.status });
    return res.status(200).json({ questions });
  } catch (err) {
    const code = err && (err.code === "timeout" || err.code === "upstream_error") ? err.code : "internal";
    return gate.fail(code, { errorName: err && (err.errorName || err.name) });
  } finally {
    await gate.release();
  }
}

function createHandler(deps) {
  return function practiceHandler(req, res) {
    return handle(req, res, deps || null);
  };
}

module.exports = createHandler(null);
module.exports.createHandler = createHandler;
