// Non-billable readiness check. Confirms the AI route configuration has the
// right shape. It does not call Anthropic or Supabase and it does not return
// secret values or variable names.
const security = require("./security");

const HEADERS = { "cache-control": "no-store" };

function createHandler(deps) {
  return async function ready(req, res) {
    const started = Date.now();
    const requestId = security.newRequestId();
    const sink = deps && deps.log;
    const env = deps && deps.env ? deps.env : process.env;
    const headers = Object.assign({ "x-request-id": requestId }, HEADERS);

    function emit(outcome, status, extra) {
      security.writeLog(Object.assign({
        requestId: requestId,
        endpoint: "ready",
        outcome: outcome,
        httpStatus: status,
        durationMs: Date.now() - started,
      }, extra || {}), sink);
    }

    if (!req || (req.method !== "GET" && req.method !== "HEAD")) {
      emit("method_not_allowed", 405);
      return security.writeJson(res, 405, { ok: false }, headers);
    }

    const cfg = security.securityConfig(env);
    const status = cfg.ok ? 200 : 503;
    emit(cfg.ok ? "ok" : "not_configured", status, cfg.ok ? null : { missing: cfg.missing });
    if (req.method === "HEAD") return security.writeJson(res, status, undefined, headers);
    return security.writeJson(res, status, { ok: cfg.ok }, headers);
  };
}

module.exports = createHandler(null);
module.exports.createHandler = createHandler;
