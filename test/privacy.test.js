"use strict";
// Privacy inventory, parent notice, retention defaults, and the coach gate.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const privacy = require(path.join(root, "privacy.js"));

let passed = 0;
function ok(desc, cond) { assert.ok(cond, desc); passed++; }
function read(rel) { return fs.readFileSync(path.join(root, rel), "utf8"); }

(function () {
  const locations = {};
  privacy.INVENTORY.forEach((item) => {
    locations[item.location] = true;
    ok(item.id + " has purpose, retention, and processor",
      item.purpose.length > 10 && item.retention.length > 10 && item.processor.length > 1);
  });
  ["indexeddb", "local-storage", "supabase-row", "supabase-blob", "ai-payload", "log"].forEach((location) => {
    ok("inventory covers " + location, locations[location] === true);
  });
  ok("log retention is 7 days", privacy.LOG_RETENTION_DAYS === 7 && privacy.LOG_RETENTION_MS === 7 * 24 * 60 * 60 * 1000);
  const now = 1700000000000;
  const fresh = privacy.pruneTimestamps([now - 1000, now - privacy.LOG_RETENTION_MS - 1], now);
  ok("prune keeps a recent stamp and drops an old one", fresh.length === 1 && fresh[0] === now - 1000);

  const notice = privacy.privacyNotice.concat(privacy.aiDisclosure).join("\n");
  ok("notice says it has not been checked by a lawyer", notice.indexOf("has not been checked by a lawyer") !== -1);
  ok("notice does not claim approval", !/lawyer has approved|legally approved|ICO has approved|official approval of the AI/i.test(notice));
  ok("confirmation phrase is exact", privacy.DELETE_CONFIRMATION === "DELETE MY CLOUD ACCOUNT");
  ok("deletion ends with the auth user", privacy.DELETION_ORDER[privacy.DELETION_ORDER.length - 1] === "auth-user");
  ok("deletion removes storage before records", privacy.DELETION_ORDER.indexOf("storage-objects") < privacy.DELETION_ORDER.indexOf("owner-records"));
  ok("deletion removes records before the auth user", privacy.DELETION_ORDER.indexOf("owner-records") < privacy.DELETION_ORDER.indexOf("auth-user"));

  const inventoryDoc = read("docs/data-inventory.md");
  privacy.INVENTORY.forEach((item) => {
    ok("data inventory documents " + item.id, inventoryDoc.indexOf(item.id) !== -1 && inventoryDoc.indexOf(item.purpose) !== -1 && inventoryDoc.indexOf(item.retention) !== -1);
  });
  privacy.PROCESSORS.forEach((item) => {
    ok("data inventory names " + item.name, inventoryDoc.indexOf(item.name) !== -1);
  });

  const dpia = read("docs/dpia.md");
  ok("DPIA marks legal review outstanding", dpia.indexOf("OUTSTANDING LEGAL REVIEW") !== -1);
  ok("DPIA does not claim an external review", dpia.indexOf("No lawyer has reviewed it") !== -1 && dpia.indexOf("externally reviewed and approved") === -1);
  ok("DPIA covers the Children's Code", dpia.indexOf("Age Appropriate Design Code") !== -1 && dpia.indexOf("Best interests") !== -1);

  const subs = read("docs/subprocessors.md");
  ["Supabase", "Anthropic", "Vercel", "postcodes.io"].forEach((name) => {
    ok("subprocessors list " + name, subs.indexOf(name) !== -1);
  });
  ok("subprocessors are not described as signed", subs.indexOf("not signed in this repository") !== -1 && subs.indexOf("OUTSTANDING LEGAL REVIEW") !== -1);

  const runbook = read("docs/retention-deletion-runbook.md");
  ok("runbook states 7 day logs and forbids a live delete from this repo",
    runbook.indexOf("7 days") !== -1 && runbook.indexOf("does not delete a live Supabase project") !== -1);
  ok("runbook keeps local export and the confirmation phrase",
    runbook.indexOf("Export backup") !== -1 && runbook.indexOf(privacy.DELETE_CONFIRMATION) !== -1);
  privacy.DELETION_ORDER.forEach((step) => {
    const label = step === "auth-user" ? "auth user"
      : step === "storage-objects" ? "uid/"
      : step === "owner-records" ? "public.records"
      : step === "analysis-leases" ? "ai_analysis_leases"
      : step === "beta-admissions" ? "beta_admissions"
      : "ai_quota_counters";
    ok("runbook follows " + step, runbook.indexOf(label) !== -1);
  });

  const app = read("app.js");
  const runAt = app.indexOf("async function runCoach");
  const coachAt = app.indexOf('fetch("/api/coach"', runAt);
  const coachBefore = app.slice(runAt, coachAt);
  ok("coach checks the Enhanced AI switch before the request", coachBefore.indexOf("analyzer.enhancedAi.enabled") !== -1);
  ok("coach checks the consent box before the request", coachBefore.indexOf("coach-consent") !== -1);
  ok("on-device export remains", app.indexOf("EduStore.exportAll") !== -1 && app.indexOf("export-backup") !== -1);
  ok("cloud delete sends the shared confirmation", app.indexOf("DELETE_CONFIRMATION") !== -1 && app.indexOf('fetch("/api/account-delete"') !== -1);

  const clientReport = read("api/client-report.js");
  ok("error reports prune at the log retention window", clientReport.indexOf("pruneTimestamps") !== -1 && clientReport.indexOf("LOG_RETENTION_MS") !== -1);

  console.log("privacy.test.js: " + passed + " assertions passed");
})();
