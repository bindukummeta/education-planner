// Browser boot config for one deployment. Values come from that process's
// environment. The body is the public Supabase URL, the anon key, the
// environment name, and the client-report toggle. The service-role key,
// pepper, and Anthropic key are never included. Responses are no-store so a
// preview host cannot keep a production binding.
const security = require("./security");

const HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
  expires: "0",
};

function createHandler(deps) {
  return async function publicConfig(req, res) {
    const started = Date.now();
    const requestId = security.newRequestId();
    const sink = deps && deps.log;
    const env = deps && deps.env ? deps.env : process.env;
    const headers = Object.assign({ "x-request-id": requestId }, HEADERS);

    function emit(outcome, status) {
      security.writeLog({
        requestId: requestId,
        endpoint: "public-config",
        outcome: outcome,
        httpStatus: status,
        durationMs: Date.now() - started,
      }, sink);
    }

    if (!req || (req.method !== "GET" && req.method !== "HEAD")) {
      emit("method_not_allowed", 405);
      return security.writeJson(res, 405, { ok: false }, headers);
    }

    const cfg = security.publicRuntimeConfig(env);
    const previewProduction = securityPublicPreviewBlock(env);
    const outcome = cfg.ok ? "ok" : (previewProduction ? "disabled" : "not_configured");
    const status = cfg.ok ? 200 : 503;
    emit(outcome, status);
    if (req.method === "HEAD") return security.writeJson(res, status, undefined, headers);
    return security.writeJson(res, status, {
      ok: cfg.ok,
      environment: cfg.environment,
      supabaseUrl: cfg.supabaseUrl,
      supabaseAnonKey: cfg.supabaseAnonKey,
      clientReports: cfg.clientReports,
    }, headers);
  };
}

function securityPublicPreviewBlock(env) {
  const vercel = env && typeof env.VERCEL_ENV === "string" ? env.VERCEL_ENV.trim() : "";
  const app = env && typeof env.APP_ENV === "string" ? env.APP_ENV.trim() : "";
  return vercel === "preview" && app === "production";
}

module.exports = createHandler(null);
module.exports.createHandler = createHandler;
