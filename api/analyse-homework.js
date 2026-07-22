// api/analyse-homework.js
// Enhanced AI (opt-in) homework vision analysis. Mirrors api/coach.js conventions.
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";
const ALLOWED_MEDIA = ["image/jpeg", "image/png"];
const MAX_DECODED_BYTES = 3 * 1024 * 1024; // 3 MB decoded ceiling; client targets < 2 MB
const ERROR_TYPES = ["concept", "calculation", "instruction", "incomplete", "time", "skipped", "other"];
const CORRECTNESS = ["correct", "incorrect", "partial", "unclear"];

const SYSTEM_PROMPT = `You are a warm, encouraging assistant that helps a PARENT review their child's Maths homework.
You are given a photo of ONE child's one-page Maths worksheet. Your job is to read it carefully
and produce a structured record that the parent will review, correct, and approve. You are NOT
grading the child and you are NOT talking to the child. Everything you produce is a SUGGESTION for
the parent to confirm.

WHAT TO EXTRACT
For each question you can see on the worksheet, extract:
- questionText: the printed question text, copied verbatim as printed.
- studentAnswer: the child's visible handwritten answer if you can read it clearly; otherwise null.
- expectedAnswer: work out the correct answer to the question yourself and give it here (a short
  value, e.g. "42" or "3/4"). Only use null if the question genuinely has no single correct answer.
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

HONESTY RULES
- If the handwriting or answer is unreadable, set studentAnswer to null, correctness to "unclear",
  and needsReview to true. NEVER invent or guess a mark.
- Prefer null over a guess. These are SUGGESTIONS the parent will confirm.

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
          "questionText", "studentAnswer", "correctness",
          "reasoningSummary", "confidence", "needsReview"
        ]
      }
    }
  },
  required: ["overall", "attempts"]
};

function buildUserPrompt(subject) {
  return "This is a photo of ONE child's " + subject + " worksheet. " +
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

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY. Set it in Vercel env vars or .env.local." });
  const model = process.env.ANTHROPIC_VISION_MODEL || DEFAULT_MODEL;

  let body = req.body;
  try { if (typeof body === "string") body = JSON.parse(body); } catch (e) { body = null; }
  if (!body || typeof body !== "object") return res.status(400).json({ error: "Invalid request" });

  const image = body.image || {};
  const subject = typeof body.subject === "string" && body.subject.trim() ? body.subject.trim() : "";
  if (!subject) return res.status(400).json({ error: "Subject is required" });
  if (!ALLOWED_MEDIA.includes(image.mediaType)) return res.status(400).json({ error: "Unsupported image type" });
  if (typeof image.data !== "string" || !image.data) return res.status(400).json({ error: "Missing image data" });
  if (image.data.length * 0.75 > MAX_DECODED_BYTES) return res.status(413).json({ error: "Image too large" });

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
        max_tokens: 8192,
        // Claude Sonnet 5 runs adaptive thinking by default, which shares the
        // max_tokens budget with the answer — a tight budget gets spent on thinking
        // and truncates the JSON (stop_reason: max_tokens). This is a structured
        // extraction task, not deep reasoning, so disable thinking to reserve the
        // whole budget for the output.
        thinking: { type: "disabled" },
        // Structured Outputs (GA output_config.format, no beta header) — constrains
        // decoding so the response is guaranteed schema-valid JSON.
        output_config: { format: { type: "json_schema", schema: RESPONSE_SCHEMA } },
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
            { type: "text", text: buildUserPrompt(subject) }
          ]
        }]
      })
    });

    if (!upstream.ok) {
      // Surface the real upstream reason (like api/coach.js) so failures are
      // diagnosable instead of a generic "unavailable".
      let detail = "HTTP " + upstream.status;
      try {
        const errData = await upstream.json();
        detail = (errData && errData.error && errData.error.message) || detail;
      } catch (_) { /* keep HTTP status */ }
      return res.status(502).json({ error: "Analysis service error: " + detail, status: upstream.status });
    }
    const data = await upstream.json();
    // Structured Outputs returns the JSON as text in content[0].text, but be
    // tolerant: join every content part that carries a string `text`.
    const text = Array.isArray(data.content)
      ? data.content.filter(p => p && typeof p.text === "string").map(p => p.text).join("")
      : "";
    const stop = data && data.stop_reason;
    if (!text.trim()) {
      // No JSON at all — surface why (e.g. refusal, or an empty response) so it's
      // diagnosable instead of a generic "invalid JSON".
      return res.status(502).json({ error: "The analysis came back empty" + (stop ? " (stop reason: " + stop + ")" : "") + ". Please try a clearer photo." });
    }
    let parsed;
    try {
      const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // A truncated response (hit max_tokens) is the usual cause of invalid JSON.
      const hint = stop === "max_tokens"
        ? " The response was too long and got cut off — try a worksheet with fewer questions."
        : "";
      return res.status(502).json({ error: "Could not read the analysis (invalid JSON from model)." + hint });
    }
    return res.status(200).json(normalizePayload(parsed, model, subject));
  } catch (err) {
    return res.status(500).json({ error: "Something went wrong analysing the photo: " + ((err && err.message) || String(err)) });
  }
};
