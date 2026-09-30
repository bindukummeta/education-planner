"use strict";
// Public config is per deployment, uncached, and free of server secrets.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const security = require(path.join(root, "api", "security.js"));
const endpoint = require(path.join(root, "api", "public-config.js"));
const client = require(path.join(root, "public-config.js"));

let passed = 0;
function ok(desc, cond) { assert.ok(cond, desc); passed++; }
function read(rel) { return fs.readFileSync(path.join(root, rel), "utf8"); }

const ANON = "anon-key-0123456789abcdef";
const SERVICE = "service-role-0123456789abcdef";
const PEPPER = "pepper-0123456789abcdef";
const ANTHROPIC = "test-anthropic-key-0123456789";
const CANARY = "canary-secret-value-not-for-output";

function env(extra) {
  return Object.assign({
    APP_ENV: "staging",
    SUPABASE_URL: "https://staging.example.supabase.co",
    SUPABASE_ANON_KEY: ANON,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE,
    API_QUOTA_PEPPER: PEPPER,
    ANTHROPIC_API_KEY: ANTHROPIC,
  }, extra || {});
}

function mockRes() {
  const headers = {};
  return {
    statusCode: 0,
    jsonBody: undefined,
    headers: headers,
    setHeader(key, value) { headers[String(key).toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.jsonBody = payload; return this; },
    end() { this.ended = true; return this; },
  };
}

async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return res;
}

(async function () {
  const shipped = read("sync-config.js");
  ok("shipped sync config has no host", shipped.indexOf("supabase.co") === -1);
  ok("shipped sync config has no jwt", shipped.indexOf("eyJ") === -1);
  ok("shipped sync config is empty", shipped.indexOf('url: ""') !== -1 && shipped.indexOf('anonKey: ""') !== -1);

  const example = read(".env.example");
  ok("env example names the public and server variables", ["APP_ENV", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "API_QUOTA_PEPPER", "ANTHROPIC_API_KEY", "CLIENT_ERROR_REPORTS", "ALLOW_PREVIEW_PUBLIC_CONFIG"].every((name) => example.indexOf(name) !== -1));
  ok("env example has no live secret", example.indexOf("eyJ") === -1 && example.indexOf("sk-ant") === -1 && example.indexOf(CANARY) === -1);
  ok("env example forbids production secrets on preview", example.toLowerCase().indexOf("preview") !== -1 && example.toLowerCase().indexOf("production") !== -1);

  const good = security.publicRuntimeConfig(env());
  ok("staging config is public only", good.ok === true && good.environment === "staging" && good.supabaseUrl === "https://staging.example.supabase.co" && good.supabaseAnonKey === ANON && good.clientReports === false);
  ok("config object has no service role", JSON.stringify(good).indexOf(SERVICE) === -1 && JSON.stringify(good).indexOf(ANTHROPIC) === -1 && JSON.stringify(good).indexOf(PEPPER) === -1);

  const reportsOn = security.publicRuntimeConfig(env({ CLIENT_ERROR_REPORTS: "on" }));
  ok("client reports follow the exact on switch", reportsOn.clientReports === true);
  ok("other report values stay off", security.publicRuntimeConfig(env({ CLIENT_ERROR_REPORTS: "true" })).clientReports === false);
  ok("blank report switch stays off", security.publicRuntimeConfig(env({ CLIENT_ERROR_REPORTS: "" })).clientReports === false);

  ok("missing env fails closed", security.publicRuntimeConfig({}).ok === false && security.publicRuntimeConfig({}).supabaseAnonKey === "");
  ok("http supabase url is refused", security.publicRuntimeConfig(env({ SUPABASE_URL: "http://staging.example.supabase.co" })).ok === false);
  ok("url with a path is refused", security.publicRuntimeConfig(env({ SUPABASE_URL: "https://staging.example.supabase.co/rest/v1" })).supabaseUrl === "");
  ok("identical anon and service role is refused", security.publicRuntimeConfig(env({ SUPABASE_ANON_KEY: SERVICE })).ok === false && security.publicRuntimeConfig(env({ SUPABASE_ANON_KEY: SERVICE })).supabaseAnonKey === "");
  ok("placeholder anon key is refused", security.publicRuntimeConfig(env({ SUPABASE_ANON_KEY: "<anon-key>" })).ok === false);

  const previewProd = security.publicRuntimeConfig(env({ APP_ENV: "production", VERCEL_ENV: "preview", ALLOW_PREVIEW_PUBLIC_CONFIG: "production" }));
  ok("preview does not serve production", previewProd.ok === false && previewProd.environment === "unconfigured" && previewProd.supabaseAnonKey === "" && JSON.stringify(previewProd).indexOf(ANON) === -1);
  const previewStaging = security.publicRuntimeConfig(env({ VERCEL_ENV: "preview", ALLOW_PREVIEW_PUBLIC_CONFIG: "staging" }));
  ok("staging preview can serve staging", previewStaging.ok === true && previewStaging.environment === "staging");
  ok("preview without the allow switch is refused", security.publicRuntimeConfig(env({ VERCEL_ENV: "preview" })).ok === false);
  ok("production host can serve production", security.publicRuntimeConfig(env({ APP_ENV: "production", VERCEL_ENV: "production" })).environment === "production");
  ok("production host does not serve a local label", security.publicRuntimeConfig(env({ APP_ENV: "local", VERCEL_ENV: "production" })).ok === false);
  ok("staging project primary deploy is staging", security.publicRuntimeConfig(env({ APP_ENV: "staging", VERCEL_ENV: "production" })).environment === "staging");
  ok("local shell can serve local", security.publicRuntimeConfig(env({ APP_ENV: "local" })).environment === "local");

  let network = 0;
  const handler = endpoint.createHandler({
    env: env({ CLIENT_ERROR_REPORTS: "on" }),
    log: (entry) => { network = entry; },
    fetch: () => { network = "called"; return Promise.reject(new Error("no network")); },
  });
  const res = await call(handler, { method: "GET" });
  ok("endpoint returns the public body", res.statusCode === 200 && res.jsonBody.ok === true && res.jsonBody.environment === "staging" && res.jsonBody.supabaseAnonKey === ANON && res.jsonBody.clientReports === true);
  ok("endpoint cache is no-store", String(res.headers["cache-control"]).indexOf("no-store") !== -1);
  ok("endpoint body drops server secrets", JSON.stringify(res.jsonBody).indexOf(SERVICE) === -1 && JSON.stringify(res.jsonBody).indexOf(ANTHROPIC) === -1 && JSON.stringify(res.jsonBody).indexOf(PEPPER) === -1);
  ok("endpoint does not call fetch", network !== "called" && network.endpoint === "public-config" && network.outcome === "ok");
  const keys = Object.keys(res.jsonBody).sort();
  ok("endpoint keys are fixed", keys.join(",") === "clientReports,environment,ok,supabaseAnonKey,supabaseUrl");

  const blocked = await call(endpoint.createHandler({
    env: env({ APP_ENV: "production", VERCEL_ENV: "preview", SUPABASE_SERVICE_ROLE_KEY: CANARY + "-0123456789abcd" }),
    log: () => {},
  }), { method: "GET" });
  ok("preview production response is empty", blocked.statusCode === 503 && blocked.jsonBody.supabaseAnonKey === "" && JSON.stringify(blocked.jsonBody).indexOf(CANARY) === -1 && JSON.stringify(blocked.jsonBody).indexOf(ANON) === -1);

  const head = await call(handler, { method: "HEAD" });
  ok("head has status and no body", head.statusCode === 200 && head.jsonBody === undefined);
  const posted = await call(handler, { method: "POST" });
  ok("post is refused", posted.statusCode === 405 && posted.jsonBody.ok === false && posted.jsonBody.supabaseAnonKey === undefined);

  const src = read("api/public-config.js");
  ok("handler source does not fetch", src.indexOf("fetch(") === -1 && src.indexOf("anthropic") === -1);

  const boot = read("public-config.js");
  ok("boot script does not persist config", boot.indexOf("localStorage") === -1 && boot.indexOf("sessionStorage") === -1 && boot.indexOf("indexedDB") === -1 && boot.indexOf("caches") === -1);
  ok("boot script asks for no-store", boot.indexOf('cache: "no-store"') !== -1);

  const win = { EDU_SYNC_CONFIG: { url: "https://stale.example", anonKey: ANON } };
  const applied = await client.apply(win, async (url, opts) => {
    ok("boot fetch is no-store", url === "/api/public-config" && opts.cache === "no-store");
    return { ok: true, json: async () => ({ ok: true, environment: "staging", supabaseUrl: "https://staging.example.supabase.co", supabaseAnonKey: ANON, clientReports: false, serviceRole: SERVICE }) };
  });
  ok("boot keeps the origin only", applied.sync === true && win.EDU_SYNC_CONFIG.url === "https://staging.example.supabase.co" && win.EDU_SYNC_CONFIG.anonKey === ANON);
  ok("boot ignores extra secret fields", JSON.stringify(win.EDU_SYNC_CONFIG).indexOf(SERVICE) === -1 && win.EDU_OBSERVABILITY.clientReports === false);
  ok("boot rejects a supabase path", client.accept({ ok: true, environment: "staging", supabaseUrl: "https://staging.example.supabase.co/extra", supabaseAnonKey: ANON, clientReports: false }) === null);

  const cleared = await client.apply(win, async () => { throw new Error("offline"); });
  ok("a failed boot drops the previous environment", cleared.sync === false && win.EDU_PUBLIC_ENV === "unconfigured" && win.EDU_SYNC_CONFIG.url === "" && win.EDU_SYNC_CONFIG.anonKey === "" && win.EDU_OBSERVABILITY.clientReports === false);

  const offline = await client.apply({}, async () => ({ ok: false, status: 503, json: async () => ({ ok: false, supabaseAnonKey: ANON }) }));
  ok("non-ok response does not apply a key", offline.sync === false);

  const worker = read("service-worker.js");
  const fetchAt = worker.indexOf('self.addEventListener("fetch"');
  const bypass = worker.indexOf('url.pathname.indexOf("/api/") === 0');
  ok("service worker does not cache api responses", fetchAt !== -1 && bypass > fetchAt && worker.indexOf("eduplanner-v64") !== -1 && worker.indexOf("./public-config.js") !== -1);
  ok("public config endpoint is not a precached asset", worker.indexOf("./api/public-config") === -1);

  const html = read("index.html");
  ok("boot script loads before the app", html.indexOf("public-config.js") !== -1 && html.indexOf("sync-config.js") < html.indexOf("public-config.js") && html.indexOf("public-config.js") < html.indexOf("app.js"));
  ok("app waits for public config", read("app.js").indexOf("EduPublicConfig.apply") !== -1);

  const checklist = read("docs/release-checklist.md");
  ["check:env", "ENFORCE_ENV=1", "/api/public-config", "docs/environments.md", "docs/operations-roles.md", "docs/runbooks/deployment.md", "docs/runbooks/restore-drill.md", "eduplanner-v64", "ALLOW_PREVIEW_PUBLIC_CONFIG"].forEach((part) => {
    ok("release checklist mentions " + part, checklist.indexOf(part) !== -1);
  });

  const readme = read("README.md");
  ["local", "staging", "production", ".env.example", "docs/environments.md", "docs/runbooks/deployment.md", "npm test", "npm run check:syntax", "npm run test:browser"].forEach((part) => {
    ok("readme mentions " + part, readme.indexOf(part) !== -1);
  });
  ok("readme has no jwt", readme.indexOf("eyJ") === -1);

  const requiredDocs = {
    "docs/environments.md": ["local", "staging", "production", "Preview", "production secrets"],
    "docs/operations-roles.md": ["<INCIDENT_COMMANDER>", "<SECURITY_ALERT_OWNER>", "<BILLING_ALERT_OWNER>", "<MIGRATION_OWNER>", "<BACKUP_OWNER>"],
    "docs/runbooks/deployment.md": ["ENFORCE_ENV=1", "npm run check:env", "/api/public-config"],
    "docs/runbooks/migrations.md": ["2026-per-account-isolation.sql", "staging"],
    "docs/runbooks/rollback.md": ["CACHE", "service-worker"],
    "docs/runbooks/key-rotation.md": ["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY", "API_QUOTA_PEPPER"],
    "docs/runbooks/outages.md": ["Supabase", "Anthropic", "Vercel"],
    "docs/runbooks/account-deletion.md": ["account-delete", "<PRIVACY_OWNER>"],
    "docs/runbooks/backup-restore.md": ["PITR", "production"],
    "docs/runbooks/restore-drill.md": ["ops/evidence/restore-drill-template.md", "EXTERNAL"],
    "ops/evidence/restore-drill-template.md": ["<BACKUP_OWNER>", "must not be the production project", "pass/fail"],
  };
  Object.keys(requiredDocs).forEach((rel) => {
    const text = read(rel);
    requiredDocs[rel].forEach((part) => ok(rel + " contains " + part, text.indexOf(part) !== -1));
    ok(rel + " has no jwt", text.indexOf("eyJ") === -1);
  });

  const listed = spawnSync(process.execPath, ["scripts/runbook.js"], { cwd: root, encoding: "utf8" });
  ok("runbook list exits clean", listed.status === 0 && listed.stdout.indexOf("docs/runbooks/restore-drill.md") !== -1);
  const refused = spawnSync(process.execPath, ["scripts/runbook.js", "restore-drill", "--apply"], { cwd: root, encoding: "utf8" });
  ok("restore drill apply is refused", refused.status === 2 && refused.stderr.indexOf("EXTERNAL BLOCKER") !== -1 && (refused.stdout + refused.stderr).indexOf("eyJ") === -1 && (refused.stdout + refused.stderr).indexOf(CANARY) === -1);
  const skipped = spawnSync(process.execPath, ["scripts/validate-env.js"], {
    cwd: root,
    encoding: "utf8",
    env: Object.assign({}, process.env, { ENFORCE_ENV: "" }),
  });
  ok("env check skips without enforcement", skipped.status === 0 && skipped.stdout.indexOf("ENFORCE_ENV=1") !== -1 && skipped.stdout.indexOf(CANARY) === -1);

  const enforced = spawnSync(process.execPath, ["scripts/validate-env.js"], {
    cwd: root,
    encoding: "utf8",
    env: Object.assign({}, process.env, {
      ENFORCE_ENV: "1",
      APP_ENV: "production",
      VERCEL_ENV: "preview",
      ALLOW_PREVIEW_PUBLIC_CONFIG: "production",
      SUPABASE_URL: "https://prod.example.supabase.co",
      SUPABASE_ANON_KEY: ANON,
      SUPABASE_SERVICE_ROLE_KEY: CANARY + "-0123456789abcd",
      API_QUOTA_PEPPER: PEPPER,
      ANTHROPIC_API_KEY: ANTHROPIC,
    }),
  });
  ok("enforced preview production check fails", enforced.status === 1);
  ok("enforced check does not print secrets", (enforced.stdout + enforced.stderr).indexOf(CANARY) === -1 && (enforced.stdout + enforced.stderr).indexOf(ANON) === -1);

  const localOk = spawnSync(process.execPath, ["scripts/validate-env.js"], {
    cwd: root,
    encoding: "utf8",
    env: Object.assign({}, process.env, {
      ENFORCE_ENV: "1",
      APP_ENV: "local",
      VERCEL_ENV: "",
      SUPABASE_URL: "https://local.example.supabase.co",
      SUPABASE_ANON_KEY: ANON,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE,
      API_QUOTA_PEPPER: PEPPER,
      ANTHROPIC_API_KEY: ANTHROPIC,
      CLIENT_ERROR_REPORTS: "",
    }),
  });
  ok("enforced local shell passes", localOk.status === 0 && localOk.stdout.indexOf("local ok") !== -1 && localOk.stdout.indexOf(SERVICE) === -1);

  console.log("public-config.test.js: " + passed + " assertions passed");
})().catch((err) => { console.error(err); process.exit(1); });
