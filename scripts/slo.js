"use strict";
// Prints the initial SLO definitions and their 28-day error budgets.
// It does not query Vercel, Supabase, or Anthropic.
const fs = require("fs");
const path = require("path");

const DEFAULT_PATH = path.join(__dirname, "..", "ops", "slo.json");

function errorBudgetMinutes(successTarget, windowDays) {
  return (1 - successTarget) * windowDays * 24 * 60;
}

function load(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!raw || raw.schemaVersion !== 1) throw new Error("slo schema");
  if (raw.windowDays !== 28) throw new Error("slo window");
  if (!Array.isArray(raw.objectives) || raw.objectives.length < 6) throw new Error("slo objectives");
  const required = ["static_shell", "readiness", "coach", "generate_practice", "analyse_homework", "sync"];
  const ids = raw.objectives.map((item) => item.id);
  required.forEach((id) => {
    if (ids.indexOf(id) === -1) throw new Error("missing " + id);
  });
  const objectives = raw.objectives.map((item) => {
    if (typeof item.successTarget !== "number" || item.successTarget <= 0 || item.successTarget >= 1) {
      throw new Error("success target " + item.id);
    }
    if (typeof item.p95TargetMs !== "number" || item.p95TargetMs <= 0) throw new Error("p95 " + item.id);
    if (typeof item.query !== "string" || item.query.length < 20) throw new Error("query " + item.id);
    return {
      id: item.id,
      surface: item.surface,
      group: item.group,
      successTarget: item.successTarget,
      p95TargetMs: item.p95TargetMs,
      errorBudgetMinutes: errorBudgetMinutes(item.successTarget, raw.windowDays),
      query: item.query,
    };
  });
  return {
    windowDays: raw.windowDays,
    status: raw.status,
    excludedOutcomes: raw.excludedOutcomes,
    objectives: objectives,
  };
}

function main() {
  const filePath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_PATH;
  const report = load(filePath);
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("slo: " + (err && err.message ? err.message : "failed"));
    process.exit(1);
  }
}

module.exports = {
  errorBudgetMinutes: errorBudgetMinutes,
  load: load,
  DEFAULT_PATH: DEFAULT_PATH,
};
