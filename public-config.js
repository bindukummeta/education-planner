// Loads this deployment's public config at boot. The shipped sync-config.js
// stays empty. Nothing here is written into storage: a later visit, or another
// environment on another host, must not reuse this response.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (typeof root === "object" && root) root.EduPublicConfig = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var ENVIRONMENTS = { local: 1, staging: 1, production: 1 };
  var TIMEOUT_MS = 4000;

  function accept(payload) {
    if (!payload || typeof payload !== "object" || payload.ok !== true) return null;
    if (!ENVIRONMENTS[payload.environment]) return null;
    if (payload.clientReports !== true && payload.clientReports !== false) return null;
    if (typeof payload.supabaseUrl !== "string" || typeof payload.supabaseAnonKey !== "string") return null;
    if (payload.supabaseAnonKey.length < 20 || payload.supabaseAnonKey.indexOf("<") !== -1) return null;
    var parsed;
    try { parsed = new URL(payload.supabaseUrl); } catch (err) { return null; }
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.pathname && parsed.pathname !== "/") return null;
    return {
      environment: payload.environment,
      url: parsed.origin,
      anonKey: payload.supabaseAnonKey,
      clientReports: payload.clientReports === true,
    };
  }

  function disabled(target) {
    if (target) {
      target.EDU_SYNC_CONFIG = { url: "", anonKey: "" };
      target.EDU_OBSERVABILITY = { clientReports: false };
      target.EDU_PUBLIC_ENV = "unconfigured";
    }
    return { environment: "unconfigured", sync: false, clientReports: false };
  }

  function apply(win, fetchImpl) {
    var target = win || (typeof window !== "undefined" ? window : null);
    var fetchFn = typeof fetchImpl === "function"
      ? fetchImpl
      : (target && typeof target.fetch === "function" ? target.fetch.bind(target) : null);
    if (!target || typeof fetchFn !== "function") return Promise.resolve(disabled(target));

    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () {
      try { ctrl.abort(); } catch (err) { /* timeout must not throw */ }
    }, TIMEOUT_MS) : null;

    return fetchFn("/api/public-config", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (res) {
      if (!res || res.ok !== true || typeof res.json !== "function") return null;
      return res.json();
    }).then(function (payload) {
      var accepted = accept(payload);
      if (!accepted) return disabled(target);
      target.EDU_SYNC_CONFIG = { url: accepted.url, anonKey: accepted.anonKey };
      target.EDU_OBSERVABILITY = { clientReports: accepted.clientReports };
      target.EDU_PUBLIC_ENV = accepted.environment;
      return {
        environment: accepted.environment,
        sync: true,
        clientReports: accepted.clientReports,
      };
    }).catch(function () {
      return disabled(target);
    }).then(function (result) {
      if (timer) clearTimeout(timer);
      return result;
    });
  }

  return { accept: accept, apply: apply, TIMEOUT_MS: TIMEOUT_MS };
});
