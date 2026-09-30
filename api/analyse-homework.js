// api/analyse-homework.js
// Enhanced AI (opt-in) homework vision analysis. Auth, quotas, body limits, and
// the upstream timeout live in api/security.js. The timeout stays under Vercel's
// maxDuration (300s, see vercel.json) so a slow model returns 504 with a body.
const security = require("./security");
const DEFAULT_MODEL = "claude-sonnet-5";
// Output-token ceiling for the extraction. A worksheet with many questions
// produces a long JSON array; at 8192 the response was truncated mid-JSON
// (stop_reason: max_tokens) and failed to parse. Sonnet-class models support
// far more, so give the structured output ample room. Overridable per-env.
const MAX_OUTPUT_TOKENS = Number(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS) || 32000;
// Reasoning depth for adaptive thinking (output_config.effort): "low" | "medium"
// | "high". Higher = more accurate answers but slower; "medium" is a safe default
// against the upstream timeout. Overridable per-env.
const ANTHROPIC_EFFORT = process.env.ANTHROPIC_EFFORT || "medium";
const ERROR_TYPES = ["concept", "calculation", "instruction", "incomplete", "time", "skipped", "other"];
const CORRECTNESS = ["correct", "incorrect", "partial", "unclear"];

const SYSTEM_PROMPT = `You are a warm, encouraging assistant that helps a PARENT review their child's Maths homework.
You are given one or more photos that together make up ONE child's Maths worksheet (it may run over
several pages — for example, context or a passage on one page and the questions on another). Treat all
the photos as a single worksheet: read them together, in order, and use any context from earlier pages
when judging the questions on later pages. Your job is to read it carefully and produce a structured
record that the parent will review, correct, and approve. You are NOT grading the child and you are NOT
talking to the child. Everything you produce is a SUGGESTION for the parent to confirm.

WHAT TO EXTRACT
For each question you can see on the worksheet, extract:
- questionText: the printed question text, copied verbatim as printed.
- studentAnswer: ONLY what the CHILD wrote by hand (their pencil/pen handwriting). If the value is
  printed as part of the worksheet, it is NOT the child's answer — use null. If you cannot clearly
  read the child's handwriting, use null. NEVER put your own worked-out answer here.
- working: briefly work out the correct answer to the question here, step by step, BEFORE you fill in
  expectedAnswer. Keep it short — this is your scratch space for getting the maths right.
- expectedAnswer: the correct answer that YOU worked out in "working" above (a short value, e.g. "42"
  or "3/4"). This is what the answer SHOULD be. NEVER copy the child's studentAnswer into this field.
  Only use null if the question genuinely has no single correct answer.
- correctness: compare the child's studentAnswer to the expectedAnswer you worked out and judge it as
  exactly one of "correct", "incorrect", "partial", or "unclear". Use "unclear" only when you cannot
  read the child's answer at all.
- marksAvailable and marksAwarded: only if they are clearly determinable from the sheet; otherwise null.
- errorType: if the answer is not fully correct, suggest ONE of exactly these values, else null:
  "concept", "calculation", "instruction", "incomplete", "time", "skipped", "other".
- subskill: an optional short phrase for the specific skill (e.g. "column addition"), else null.
- topic: an optional short topic label (e.g. "fractions"), else null.
- confidence: a number from 0 to 1 for how sure you are about THIS question overall.
- needsReview: true whenever confidence is low, handwriting is unclear, or you had to guess anything.
- reasoningSummary: one short, encouraging, child-safe sentence about what to practise next.

OVERALL
Also produce an "overall" object with:
- reasoningSummary: one short, warm, encouraging note about the whole worksheet.
- confidence: a number from 0 to 1 for your overall confidence in the extraction.

LANGUAGE RULES (STRICT)
- Be warm, specific, and encouraging. Always frame things as "what to practise next".
- NEVER use deficit or identity language about the child. Do NOT use words such as: weak, weakness,
  weakest, failing, fail, poor, bad, worst, behind, lazy, stupid, dumb, slow.
- NEVER use fixed-ability or identity labels such as: gifted, genius, talented, "not a maths person".
- Do not compare the child to other children. Describe the work, not the child.

DO NOT SWAP THE ANSWERS (STRICT)
- studentAnswer = what the CHILD actually wrote (their handwriting). expectedAnswer = the CORRECT
  answer YOU worked out. These are two different fields and must NEVER be swapped.
- Before finishing each question, silently check this sentence against the photo: "The child wrote
  <studentAnswer>; the correct answer is <expectedAnswer>." If it does not match, fix the fields.
- If studentAnswer and expectedAnswer end up identical but you are not fully sure you read the child's
  handwriting correctly, set needsReview to true.

HONESTY RULES
- If the handwriting or answer is unreadable, set studentAnswer to null, correctness to "unclear",
  and needsReview to true. NEVER invent or guess what the child wrote.
- Always fill in "working" and expectedAnswer if the question has a single correct answer — that is
  YOUR job, not a guess about the child. Prefer null for studentAnswer over guessing the handwriting.
- These are SUGGESTIONS the parent will confirm.

OUTPUT
- Respond with ONLY valid, minified JSON that conforms exactly to the schema you have been given.
- No markdown, no code fences, no commentary, no text before or after the JSON.`;

// Structured Outputs JSON schema (§4). Every object sets additionalProperties:false;
// no numeric/length constraints (unsupported by Structured Outputs).
const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    overall: {
      type: "object",
      additionalProperties: false,
      properties: {
        reasoningSummary: { type: "string" },
        confidence: { type: "number" }
      },
      required: ["reasoningSummary", "confidence"]
    },
    attempts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          questionText: { type: "string" },
          studentAnswer: { type: ["string", "null"] },
          // `working` comes before expectedAnswer so the model reasons out the
          // correct answer first, then commits it — Structured Outputs generates
          // properties in schema order, giving us in-band chain-of-thought.
          working: { type: ["string", "null"] },
          expectedAnswer: { type: ["string", "null"] },
          correctness: { type: "string", enum: CORRECTNESS },
          marksAwarded: { type: ["number", "null"] },
          marksAvailable: { type: ["number", "null"] },
          errorType: { anyOf: [{ type: "string", enum: ERROR_TYPES }, { type: "null" }] },
          subskill: { type: ["string", "null"] },
          topic: { type: ["string", "null"] },
          reasoningSummary: { type: "string" },
          confidence: { type: "number" },
          needsReview: { type: "boolean" }
        },
        required: [
          "questionText", "studentAnswer", "working", "correctness",
          "reasoningSummary", "confidence", "needsReview"
        ]
      }
    }
  },
  required: ["overall", "attempts"]
};

function buildUserPrompt(subject, pageCount) {
  const pages = pageCount > 1
    ? "These " + pageCount + " photos are the pages of ONE child's " + subject + " worksheet, in order. "
    : "This is a photo of ONE child's " + subject + " worksheet. ";
  return pages +
    "Extract every question you can read and respond with ONLY the minified JSON described in your instructions.";
}

function clamp01(n) { return typeof n === "number" && isFinite(n) ? Math.max(0, Math.min(1, n)) : null; }
function numOrNull(n) { return typeof n === "number" && isFinite(n) ? n : null; }
function strOrNull(s) { return typeof s === "string" && s.trim() ? s.trim() : null; }

function normalizeAttempt(a) {
  a = a && typeof a === "object" ? a : {};
  const correctness = CORRECTNESS.includes(a.correctness) ? a.correctness : "unclear";
  const errorType = ERROR_TYPES.includes(a.errorType) ? a.errorType : null;
  const confidence = clamp01(a.confidence);
  const needsReview = a.needsReview === true || confidence === null || confidence < 0.6 || correctness === "unclear";
  return {
    questionText: strOrNull(a.questionText) || "",
    studentAnswer: strOrNull(a.studentAnswer),
    working: strOrNull(a.working),
    expectedAnswer: strOrNull(a.expectedAnswer),
    correctness,
    marksAwarded: numOrNull(a.marksAwarded),
    marksAvailable: numOrNull(a.marksAvailable),
    errorType,
    subskill: strOrNull(a.subskill),
    topic: strOrNull(a.topic),
    reasoningSummary: strOrNull(a.reasoningSummary) || "",
    confidence,
    needsReview
  };
}

function normalizePayload(raw, model, subject) {
  const overall = raw && typeof raw.overall === "object" ? raw.overall : {};
  const attempts = Array.isArray(raw && raw.attempts) ? raw.attempts.map(normalizeAttempt) : [];
  return {
    provider: "anthropic",
    model,
    subject,
    overall: {
      reasoningSummary: strOrNull(overall.reasoningSummary) || "",
      confidence: clamp01(overall.confidence)
    },
    attempts
  };
}

async function handle(req, res, deps) {
  const gate = await security.protect(req, res, "analyse-homework", deps);
  if (!gate.ok) return;
  const images = gate.body.images;
  const subject = gate.body.subject;
  try {
    const apiKey = String(gate.env.ANTHROPIC_API_KEY || "").trim();
    const model = gate.env.ANTHROPIC_VISION_MODEL || DEFAULT_MODEL;
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
        // Working out each answer and grading it is genuine reasoning, so leave
        // adaptive thinking ON — without it the model does arithmetic/marking with
        // no scratchpad and produces wrong expectedAnswers. Structured Outputs is
        // compatible with thinking: the model thinks first, then the final text
        // block still conforms to the schema. Depth is controlled by output_config
        // .effort (not a token budget on adaptive models); "medium" balances
        // accuracy against the upstream timeout. Overridable per-env.
        thinking: { type: "adaptive" },
        // Structured Outputs (GA output_config.format, no beta header) — constrains
        // decoding so the response is guaranteed schema-valid JSON.
        output_config: {
          effort: ANTHROPIC_EFFORT,
          format: { type: "json_schema", schema: RESPONSE_SCHEMA }
        },
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: images
            .map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } }))
            .concat([{ type: "text", text: buildUserPrompt(subject, images.length) }])
        }]
      })
    }, gate.timeoutMs, gate.fetch);
    if (!upstream.ok) {
      const failure = await security.providerFailure(upstream);
      return gate.fail("upstream_error", failure);
    }
    const data = await upstream.json();
    const text = security.modelText(data);
    const stop = data && data.stop_reason;
    if (!text.trim()) return gate.fail("upstream_error", { providerStatus: upstream.status, stopReason: stop || "empty" });
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```json/gi, "").replace(/```/g, "").trim());
    } catch (e) {
      return gate.fail("upstream_error", { providerStatus: upstream.status, stopReason: stop || "invalid_json" });
    }
    gate.succeed({ providerStatus: upstream.status });
    return res.status(200).json(normalizePayload(parsed, model, subject));
  } catch (err) {
    const code = err && (err.code === "timeout" || err.code === "upstream_error") ? err.code : "internal";
    return gate.fail(code, { errorName: err && (err.errorName || err.name) });
  } finally {
    await gate.release();
  }
}

function createHandler(deps) {
  return function analyseHandler(req, res) {
    return handle(req, res, deps || null);
  };
}

module.exports = createHandler(null);
module.exports.createHandler = createHandler;
