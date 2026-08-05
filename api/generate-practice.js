// api/generate-practice.js
// Enhanced AI (opt-in) practice generation. Given a few of a child's OWN wrong
// questions (derived text only — never photos, names, or notes), ask Claude for
// fresh, self-contained, auto-checkable questions of the SAME skill so the child
// can practise the exact blind spot. Mirrors api/coach.js conventions: text-only
// POST, ANTHROPIC_API_KEY from env, Structured Outputs for guaranteed-valid JSON.
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_OUTPUT_TOKENS = Number(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS) || 4000;
const MAX_SAMPLES = 6;   // cap the derived examples we forward upstream
const MAX_COUNT = 8;     // cap how many fresh questions we ask for

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

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY. Set it in Vercel env vars or .env.local." });
  const model = process.env.ANTHROPIC_PRACTICE_MODEL || DEFAULT_MODEL;

  let body = req.body;
  try { if (typeof body === "string") body = JSON.parse(body); } catch (e) { body = null; }
  if (!body || typeof body !== "object") return res.status(400).json({ error: "Invalid request" });

  const subject = strOrEmpty(body.subject);
  const topic = strOrEmpty(body.topic);
  const errorType = strOrEmpty(body.errorType);
  const rawSamples = Array.isArray(body.samples) ? body.samples : [];
  const samples = rawSamples
    .map((s) => ({ questionText: strOrEmpty(s && s.questionText), expectedAnswer: strOrEmpty(s && s.expectedAnswer) }))
    .filter((s) => s.questionText)
    .slice(0, MAX_SAMPLES);
  if (!samples.length) return res.status(400).json({ error: "At least one sample question is required." });
  let count = Number(body.count);
  if (!isFinite(count) || count < 1) count = 5;
  count = Math.min(MAX_COUNT, Math.round(count));

  try {
    const upstream = await fetch(ANTHROPIC_URL, {
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
        messages: [{ role: "user", content: buildUserPrompt(subject, topic, errorType, samples, count) }]
      })
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      const detail = (data && data.error && data.error.message) || ("HTTP " + upstream.status);
      return res.status(502).json({ error: "Practice service error: " + detail });
    }
    const text = Array.isArray(data.content)
      ? data.content.filter((p) => p && typeof p.text === "string").map((p) => p.text).join("")
      : "";
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
    if (!parsed) return res.status(502).json({ error: "The practice questions didn't come back in a usable form. Please try again." });
    const questions = normalizeQuestions(parsed, count);
    if (!questions.length) return res.status(502).json({ error: "No usable practice questions were generated. Please try again." });
    return res.status(200).json({ questions });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
