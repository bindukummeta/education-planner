"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const security = require(path.join(root, "api", "security.js"));
const coach = require(path.join(root, "api", "coach.js"));
const accountExport = require(path.join(root, "api", "account-export.js"));

let passed = 0;
function ok(desc, cond) { assert.ok(cond, desc); passed++; }

const USER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key-0123456789abcdef",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-0123456789abcdef",
  API_QUOTA_PEPPER: "pepper-0123456789abcdef",
  ANTHROPIC_API_KEY: "test-anthropic-key-0123456789",
};
const TOKEN = "Bearer aaaaaaaa.bbbbbbbb.cccccccc";

function jsonRes(status, body) {
  return { ok: status >= 200 && status < 300, status: status, json: async () => body };
}

async function call(handler, body) {
  let statusCode = 0;
  let jsonBody = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { jsonBody = payload; return this; },
    setHeader() { return this; },
  };
  await handler({
    method: "POST",
    body: body,
    headers: { authorization: TOKEN, "x-real-ip": "203.0.113.10" },
  }, res);
  return { statusCode: statusCode, jsonBody: jsonBody };
}

function injected(env, betaAllows, fetchImpl) {
  const logs = [];
  const calls = [];
  const handler = coach.createHandler({
    env: env,
    log: (entry) => logs.push(entry),
    verifyAccessToken: async () => ({ userId: USER }),
    consumeQuota: async () => ({ ok: true }),
    releaseConcurrency: async () => {},
    betaAllows: betaAllows,
    fetch: fetchImpl || (async (url) => {
      calls.push(String(url));
      return jsonRes(200, { content: [{ text: "kept advice" }] });
    }),
  });
  return { handler: handler, logs: logs, calls: calls };
}

(async function () {
  const open = injected(ENV);
  const openRes = await call(open.handler, { snapshot: { subjects: [{ subject: "Maths", recentAvg: 50 }] } });
  ok("an injected unit test with unset BETA_MODE is not the production gate", openRes.statusCode === 200 && open.calls.length === 1);

  const denied = injected(Object.assign({}, ENV, { BETA_MODE: "on" }), async () => false);
  const deniedRes = await call(denied.handler, { snapshot: { subjects: [{ subject: "Maths", recentAvg: 50 }] } });
  ok("beta on denies a family that is not invited", deniedRes.statusCode === 403 && deniedRes.jsonBody.code === "not_admitted");
  ok("a denial does not call the model", denied.calls.length === 0 && denied.logs.some((entry) => entry.outcome === "not_admitted"));

  const allowed = injected(Object.assign({}, ENV, { BETA_MODE: "on" }), async (userId) => userId === USER);
  const allowedRes = await call(allowed.handler, { snapshot: { subjects: [{ subject: "Maths", recentAvg: 50 }] } });
  ok("an invited family can use coach", allowedRes.statusCode === 200 && allowed.calls.length === 1);

  const broken = injected(Object.assign({}, ENV, { BETA_MODE: "on" }), async () => { throw new Error("lookup"); });
  const brokenRes = await call(broken.handler, { snapshot: { subjects: [{ subject: "Maths", recentAvg: 50 }] } });
  ok("a lookup failure fails closed", brokenRes.statusCode === 503 && broken.calls.length === 0);

  const missing = injected(Object.assign({}, ENV, { BETA_MODE: "on" }));
  const missingRes = await call(missing.handler, { snapshot: { subjects: [{ subject: "Maths", recentAvg: 50 }] } });
  ok("injected beta without a decision fails closed", missingRes.statusCode === 503 && missing.calls.length === 0);

  let verified = false;
  const invalid = coach.createHandler({
    env: Object.assign({}, ENV, { BETA_MODE: "yes" }),
    log: () => {},
    verifyAccessToken: async () => { verified = true; return { userId: USER }; },
    consumeQuota: async () => ({ ok: true }),
    releaseConcurrency: async () => {},
    fetch: async () => { throw new Error("network"); },
  });
  const invalidRes = await call(invalid, { snapshot: { subjects: [{ subject: "Maths", recentAvg: 50 }] } });
  ok("a mistyped beta flag fails closed before auth", invalidRes.statusCode === 503 && verified === false);

  const prodCalls = [];
  let admit = false;
  const prod = coach.createHandler({
    env: Object.assign({}, ENV, { BETA_MODE: "on" }),
    log: () => {},
    fetch: async (url, opts) => {
      const target = String(url);
      prodCalls.push(target);
      if (target.indexOf("/auth/v1/user") !== -1) return jsonRes(200, { id: USER, role: "authenticated" });
      if (target.indexOf("/rpc/beta_access_allowed") !== -1) {
        const body = JSON.parse(opts.body);
        ok("the gate uses the service role and the signed-in user", opts.headers.apikey === ENV.SUPABASE_SERVICE_ROLE_KEY && body.uid === USER);
        return jsonRes(200, admit);
      }
      if (target.indexOf("/rpc/consume_ai_quota") !== -1) return jsonRes(200, { ok: true, lease_id: null });
      if (target === security.ANTHROPIC_URL) return jsonRes(200, { content: [{ text: "kept advice" }] });
      throw new Error("unexpected " + target);
    },
  });
  const prodDenied = await call(prod, { snapshot: { subjects: [{ subject: "Maths", recentAvg: 50 }] } });
  ok("production denial stops before the model", prodDenied.statusCode === 403 && prodCalls.indexOf(security.ANTHROPIC_URL) === -1);

  admit = true;
  prodCalls.length = 0;
  const prodOk = await call(prod, { snapshot: { subjects: [{ subject: "Maths", recentAvg: 50 }] } });
  ok("production admission reaches the fake model", prodOk.statusCode === 200 && prodCalls.indexOf(security.ANTHROPIC_URL) !== -1);

  admit = false;
  prodCalls.length = 0;
  const prodHandler = coach.createHandler({
    env: Object.assign({}, ENV, { BETA_MODE: "on" }),
    log: () => {},
    fetch: async (url) => {
      const target = String(url);
      prodCalls.push(target);
      if (target.indexOf("/auth/v1/user") !== -1) return jsonRes(200, { id: OTHER, role: "authenticated" });
      if (target.indexOf("/rpc/beta_access_allowed") !== -1) return jsonRes(500, { message: "down" });
      throw new Error("unexpected " + target);
    },
  });
  const rpcDown = await call(prodHandler, { snapshot: { subjects: [{ subject: "Maths", recentAvg: 50 }] } });
  ok("a failed admission RPC fails closed", rpcDown.statusCode === 503 && prodCalls.every((url) => url.indexOf("anthropic") === -1));

  const fuzzy = coach.createHandler({
    env: Object.assign({}, ENV, { BETA_MODE: "on" }),
    log: () => {},
    fetch: async (url) => {
      const target = String(url);
      if (target.indexOf("/auth/v1/user") !== -1) return jsonRes(200, { id: USER, role: "authenticated" });
      if (target.indexOf("/rpc/beta_access_allowed") !== -1) return jsonRes(200, "true");
      throw new Error("unexpected " + target);
    },
  });
  const fuzzyRes = await call(fuzzy, { snapshot: { subjects: [{ subject: "Maths", recentAvg: 50 }] } });
  ok("a non-boolean admission result is not admission", fuzzyRes.statusCode === 403);

  const exportCalls = [];
  const exporter = accountExport.createHandler({
    env: Object.assign({}, ENV, { BETA_MODE: "on" }),
    log: () => {},
    verifyAccessToken: async () => ({ userId: USER }),
    betaAllows: async () => false,
    fetch: async () => { exportCalls.push("called"); return jsonRes(200, []); },
  });
  const exported = await call(exporter, {});
  ok("account export is server-gated", exported.statusCode === 403 && exportCalls.length === 0);

  const unsetCalls = [];
  const unsetProd = coach.createHandler({
    env: ENV,
    log: () => {},
    fetch: async (url) => {
      const target = String(url);
      unsetCalls.push(target);
      if (target.indexOf("/auth/v1/user") !== -1) return jsonRes(200, { id: USER, role: "authenticated" });
      if (target.indexOf("/rpc/beta_access_allowed") !== -1) return jsonRes(200, false);
      throw new Error("unexpected " + target);
    },
  });
  const unsetDenied = await call(unsetProd, { snapshot: { subjects: [{ subject: "Maths", recentAvg: 50 }] } });
  ok("unset BETA_MODE still asks the database and fails closed", unsetDenied.statusCode === 403 && unsetCalls.some((url) => url.indexOf("beta_access_allowed") !== -1));

  const deleteCalls = [];
  const deleteApi = require(path.join(root, "api", "account-delete.js"));
  const deleter = deleteApi.createHandler({
    env: Object.assign({}, ENV, { BETA_MODE: "on" }),
    log: () => {},
    verifyAccessToken: async () => ({ userId: USER }),
    betaAllows: async () => false,
    fetch: async (url, opts) => {
      deleteCalls.push(String(url) + " " + (opts && opts.method));
      if (String(url).indexOf("/object/list/blobs") !== -1) return jsonRes(200, []);
      return jsonRes(204, null);
    },
  });
  const deleted = await call(deleter, { confirm: "DELETE MY CLOUD ACCOUNT" });
  ok("deletion remains available when admission is false", deleted.statusCode === 200 && deleted.jsonBody.deleted === true && deleteCalls.some((line) => line.indexOf("/auth/v1/admin/users/") !== -1));

  ok("the client does not hold the allowlist", fs.readFileSync(path.join(root, "app.js"), "utf8").indexOf("beta_admissions") === -1);
  ok("cap constants match the invited cohort", security.BETA_ADMISSION_CAP === 200 && security.BETA_COHORT_MIN === 50 && security.betaMode({ BETA_MODE: "on" }) === "on" && security.betaMode({ BETA_MODE: "open" }) === "open" && security.betaMode({}) === "unset" && security.betaMode({ BETA_MODE: "off" }) === "invalid" && security.betaMode({ BETA_MODE: "ON" }) === "invalid");

  const migration = fs.readFileSync(path.join(root, "supabase", "2026-beta-admission.sql"), "utf8");
  const verify = fs.readFileSync(path.join(root, "supabase", "verify-beta-admission.sql"), "utf8");
  const migrationCode = migration.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  const verifyCode = verify.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "").replace(/'(?:''|[^'])*'/g, "''");
  ok("migration defaults to beta and caps the list", /values \(1, 'beta'\)/.test(migrationCode) && migrationCode.indexOf(">= 200") !== -1);
  ok("migration fail-closes unknown modes", migrationCode.indexOf("return false") !== -1 && migrationCode.indexOf("beta_access_allowed") !== -1);
  ok("migration keeps owner checks and does not insert a family", migrationCode.indexOf("auth.uid() = owner") !== -1 && migrationCode.indexOf("insert into public.beta_admissions") === -1);
  ok("migration is one transaction without a psql metacommand", migrationCode.indexOf("\\") === -1 && /^\s*begin;/m.test(migrationCode) && /commit;\s*$/.test(migrationCode));
  const verifyStatements = verifyCode.split(";").map((part) => part.trim()).filter(Boolean);
  ok("verifier is one read-only statement", verifyStatements.length === 1 && /^\s*with\b/i.test(verifyStatements[0]));
  ok("verifier does not mutate", !/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i.test(verifyCode));

  const listed = spawnSync(process.execPath, ["scripts/runbook.js"], { cwd: root, encoding: "utf8" });
  ok("beta runbook is listed", listed.status === 0 && listed.stdout.indexOf("docs/runbooks/beta-admission.md") !== -1);
  const refused = spawnSync(process.execPath, ["scripts/runbook.js", "beta-admission", "--apply"], { cwd: root, encoding: "utf8" });
  ok("beta apply is refused", refused.status === 2 && refused.stderr.indexOf("EXTERNAL BLOCKER") !== -1);

  const badFlag = spawnSync(process.execPath, ["scripts/validate-env.js"], {
    cwd: root,
    encoding: "utf8",
    env: Object.assign({}, process.env, { ENFORCE_ENV: "", BETA_MODE: "yes" }),
  });
  ok("an invalid BETA_MODE fails the env check", badFlag.status === 1 && badFlag.stderr.indexOf("BETA_MODE") !== -1);

  const launch = fs.readFileSync(path.join(root, "docs", "beta-launch-checklist.md"), "utf8");
  const weekly = fs.readFileSync(path.join(root, "ops", "evidence", "beta-weekly-review-template.md"), "utf8");
  const evidence = fs.readFileSync(path.join(root, "ops", "evidence", "beta-launch-evidence-template.md"), "utf8");
  ok("launch checklist stays not launched", launch.indexOf("not launched") !== -1 && launch.indexOf("50") !== -1 && launch.indexOf("200") !== -1);
  ok("weekly review covers cost and the go decision", weekly.indexOf("Cost per active family") !== -1 && weekly.indexOf("Go / no-go") !== -1 && weekly.indexOf("Support contacts") !== -1);
  ok("launch evidence cannot be marked from this tree", evidence.indexOf("not launched") !== -1 && evidence.indexOf("not-launched") !== -1);

  console.log("beta-admission.test.js: " + passed + " assertions passed");
})().catch((err) => { console.error(err); process.exit(1); });
