// Shared allowlist for browser error reports. The server applies this again;
// the browser copy exists so messages, stacks, and page data are not sent.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (typeof root === "object" && root) root.EduReportPolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var SOURCES = [
    "app.js", "sync.js", "storage.js", "schools-seed.js", "sync-config.js",
    "client-report.js", "observability-config.js", "report-policy.js", "privacy.js",
    "public-config.js", "service-worker.js", "sw-boot.js", "index.html", "other"
  ];
  var KINDS = ["error", "unhandledrejection"];
  var ERROR_NAMES = [
    "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError",
    "URIError", "AggregateError", "InternalError", "AbortError", "NotAllowedError",
    "SecurityError", "NetworkError", "TimeoutError", "QuotaExceededError",
    "DataCloneError", "InvalidStateError", "NotFoundError", "NotSupportedError",
    "HierarchyRequestError", "IndexSizeError", "EncodingError", "UnknownError",
    "ConstraintError", "DataError", "TransactionInactiveError", "ReadOnlyError",
    "VersionError", "OperationError", "UnhandledRejection"
  ];

  function intOrNull(value) {
    if (typeof value === "string" && /^[0-9]{1,7}$/.test(value)) value = Number(value);
    if (typeof value !== "number" || !Number.isInteger(value)) return null;
    if (value < 0 || value > 1000000) return null;
    return value;
  }

  function sourceFromFilename(filename, pageOrigin) {
    if (typeof filename !== "string" || !filename || filename.length > 300) return "other";
    if (/[\s@\\]/.test(filename)) return "other";
    var base = filename.split("?")[0].split("#")[0];
    if (base.indexOf("://") !== -1 || base.indexOf("/") !== -1) {
      try {
        var url = new URL(base, pageOrigin || "https://local.invalid");
        if (pageOrigin && url.origin !== pageOrigin) return "other";
        if (!pageOrigin && base.indexOf("://") !== -1) return "other";
        base = url.pathname.split("/").pop();
      } catch (err) {
        return "other";
      }
    }
    base = String(base || "").split("/").pop();
    return SOURCES.indexOf(base) === -1 ? "other" : base;
  }

  function sanitize(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    if (KINDS.indexOf(input.kind) === -1) return null;
    var rawName = input.name != null ? input.name : input.errorName;
    var errorName = ERROR_NAMES.indexOf(rawName) === -1 ? "Error" : rawName;
    var source = SOURCES.indexOf(input.source) === -1 ? "other" : input.source;
    var out = { kind: input.kind, errorName: errorName, source: source };
    var line = intOrNull(input.line);
    var column = intOrNull(input.column);
    if (line != null) out.line = line;
    if (column != null) out.column = column;
    return out;
  }

  return {
    SOURCES: SOURCES,
    KINDS: KINDS,
    ERROR_NAMES: ERROR_NAMES,
    ALLOWED_KEYS: ["kind", "name", "source", "line", "column"],
    sourceFromFilename: sourceFromFilename,
    sanitize: sanitize
  };
});
