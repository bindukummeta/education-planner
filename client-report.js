// Browser half of privacy-safe error reporting. No-ops unless
// window.EDU_OBSERVABILITY.clientReports is exactly true.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (typeof root === "object" && root) root.EduClientReport = api;
  if (typeof window !== "undefined") api.install(window);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var MAX_PER_PAGE = 5;

  function policyOf(win) {
    if (win && win.EduReportPolicy) return win.EduReportPolicy;
    if (typeof EduReportPolicy !== "undefined") return EduReportPolicy;
    return null;
  }

  function enabled(win) {
    return !!(win && win.EDU_OBSERVABILITY && win.EDU_OBSERVABILITY.clientReports === true);
  }

  function pageOrigin(win) {
    try {
      return win.location && win.location.origin ? win.location.origin : "";
    } catch (err) {
      return "";
    }
  }

  function deliver(win, payload) {
    var body = JSON.stringify(payload);
    try {
      if (win.navigator && typeof win.navigator.sendBeacon === "function") {
        if (win.navigator.sendBeacon("/api/client-report", body) === true) return;
      }
    } catch (err) { /* fall through to fetch */ }
    try {
      if (typeof win.fetch === "function") {
        win.fetch("/api/client-report", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body,
          keepalive: true
        }).catch(function () {});
      }
    } catch (err2) { /* reporting must not throw */ }
  }

  function install(win) {
    if (!win || win.__eduClientReportInstalled) return { enabled: false };
    if (!enabled(win)) return { enabled: false };
    var policy = policyOf(win);
    if (!policy) return { enabled: false };
    win.__eduClientReportInstalled = true;
    var sent = [];
    var reporting = false;

    function allow(signature, now) {
      if (sent.length >= MAX_PER_PAGE) return false;
      for (var i = 0; i < sent.length; i++) {
        if (sent[i].sig === signature && now - sent[i].at < 60000) return false;
      }
      sent.push({ sig: signature, at: now });
      return true;
    }

    function report(kind, name, filename, line, column) {
      if (reporting) return;
      reporting = true;
      try {
        var safe = policy.sanitize({
          kind: kind,
          name: name,
          source: policy.sourceFromFilename(filename, pageOrigin(win)),
          line: line,
          column: column
        });
        if (!safe) return;
        var signature = safe.kind + "|" + safe.errorName + "|" + safe.source + "|" + (safe.line || 0);
        if (!allow(signature, Date.now())) return;
        var body = { kind: safe.kind, name: safe.errorName, source: safe.source };
        if (safe.line != null) body.line = safe.line;
        if (safe.column != null) body.column = safe.column;
        deliver(win, body);
      } finally {
        reporting = false;
      }
    }

    win.addEventListener("error", function (event) {
      var error = event && event.error;
      report("error", error && error.name, event && event.filename, event && event.lineno, event && event.colno);
    });
    win.addEventListener("unhandledrejection", function (event) {
      var reason = event && event.reason;
      var name = reason && typeof reason === "object" ? reason.name : "UnhandledRejection";
      report("unhandledrejection", name, "", 0, 0);
    });
    return { enabled: true };
  }

  return { install: install, MAX_PER_PAGE: MAX_PER_PAGE };
});
