// Vercel serverless function: take a compact, derived progress snapshot and ask
// Claude for tailored 11+ study advice. Only aggregate stats are sent — never
// photos, notes, or any raw personal data.
//
// The Anthropic API key is read from the ANTHROPIC_API_KEY environment variable
// (set in .env.local for local `vercel dev`, and in Vercel project settings for
// production). It is never sent to the browser. Callers must send a Supabase
// user access token; see api/README.md.

const security = require("./security");

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

function buildKidPrompt(snapshot) {
  return [
    "You are a warm, playful learning coach writing DIRECTLY to a child of about",
    "ten years old (use 'you'). Base your message ONLY on the derived snapshot",
    "below — do not invent data. Write at most 120 words: a short friendly hello,",
    "2-3 concrete FUN next steps they can do (mention practising with the games),",
    "and one cheer at the end.",
    "",
    "Make it feel personal by connecting to the WHOLE child, not just scores. When",
    "the snapshot has 'interests' (curiosity topics/questions they ask), weave one",
    "in — e.g. tie a game or activity to something they've been wondering about.",
    "When it has 'projects', celebrate what they've been making and the skills they",
    "are building. Treat these as genuine strengths to build on.",
    "",
    "STRICT RULES: Never use deficit, ability, or identity words such as weak,",
    "weakest, worst, bad, poor, behind, failing, fail, lazy, slow, stupid, dumb,",
    "genius, gifted, or talented. Never say which subject is weakest and never",
    "compare them to anyone else. Only positive, encouraging, adventurous wording.",
    "",
    "Progress snapshot:",
    JSON.stringify(snapshot, null, 2),
  ].join("\n");
}

async function handle(req, res, deps) {
  const gate = await security.protect(req, res, "coach", deps);
  if (!gate.ok) return;
  try {
    const apiKey = String(gate.env.ANTHROPIC_API_KEY || "").trim();
    const model = gate.env.ANTHROPIC_COACH_MODEL || DEFAULT_MODEL;
    const audience = gate.body.audience === "child" ? "child" : "parent";
    const prompt = audience === "child" ? buildKidPrompt(gate.body.snapshot) : buildPrompt(gate.body.snapshot);
    const upstream = await security.fetchUpstream(security.ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
      }),
    }, gate.timeoutMs, gate.fetch);
    if (!upstream.ok) {
      const failure = await security.providerFailure(upstream);
      return gate.fail("upstream_error", failure);
    }
    const data = await upstream.json();
    const advice = security.modelText(data);
    gate.succeed({ providerStatus: upstream.status });
    res.status(200).json({ advice: advice });
  } catch (err) {
    const code = err && (err.code === "timeout" || err.code === "upstream_error") ? err.code : "internal";
    return gate.fail(code, { errorName: err && (err.errorName || err.name) });
  } finally {
    await gate.release();
  }
}

function createHandler(deps) {
  return function coachHandler(req, res) {
    return handle(req, res, deps || null);
  };
}

module.exports = createHandler(null);
module.exports.createHandler = createHandler;
