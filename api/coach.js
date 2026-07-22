// Vercel serverless function: take a compact, derived progress snapshot and ask
// Claude for tailored 11+ study advice. Only aggregate stats are sent — never
// photos, notes, or any raw personal data.
//
// The Anthropic API key is read from the ANTHROPIC_API_KEY environment variable
// (set in .env.local for local `vercel dev`, and in Vercel project settings for
// production). It is never sent to the browser.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";

function buildPrompt(snapshot) {
  return [
    "You are an experienced 11+ / grammar-school entrance tutor advising a parent",
    "on how to help their daughter prepare. Be practical, encouraging, and",
    "specific. Base your advice ONLY on the progress snapshot below (derived",
    "statistics — recent subject averages, difficulty bands, per-school gaps to",
    "cut-off, and reading/mock summaries). Do not invent data.",
    "",
    "Progress snapshot:",
    JSON.stringify(snapshot, null, 2),
    "",
    "Give focused advice covering:",
    "1. Which subjects need the most attention (biggest gaps to target cut-offs).",
    "2. Whether she is working at the right difficulty for her target schools.",
    "3. Concrete next steps for the coming week (specific, achievable).",
    "4. One motivational note.",
    "",
    "Write in clear plain text with short paragraphs or bullet points. Keep it",
    "under ~350 words. Address the parent directly.",
  ].join("\n");
}

async function callClaude(apiKey, model, prompt) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ("HTTP " + res.status);
    throw new Error(msg);
  }
  return (data.content || []).map((c) => c.text || "").join("");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY. Set it in Vercel env vars or .env.local." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  const snapshot = (body && body.snapshot) || null;
  if (!snapshot) {
    res.status(400).json({ error: "No snapshot provided." });
    return;
  }

  const model = process.env.ANTHROPIC_COACH_MODEL || DEFAULT_MODEL;
  try {
    const advice = await callClaude(apiKey, model, buildPrompt(snapshot));
    res.status(200).json({ advice });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
