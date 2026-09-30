"use strict";
const assert = require("assert");
const path = require("path");
const slo = require(path.join(__dirname, "..", "scripts", "slo.js"));

let passed = 0;
function ok(desc, cond) { assert.ok(cond, desc); passed++; }

const report = slo.load(slo.DEFAULT_PATH);
const byId = {};
report.objectives.forEach((item) => { byId[item.id] = item; });

ok("window is 28 days", report.windowDays === 28);
ok("definition is not a live launch", report.status === "definition-only");
["static_shell", "readiness", "coach", "generate_practice", "analyse_homework", "sync"].forEach((id) => {
  ok(id + " has a success target and a p95", byId[id].successTarget > 0.9 && byId[id].p95TargetMs > 0 && byId[id].query.length > 20);
});
ok("coach and practice share a group", byId.coach.group === "coach/practice" && byId.generate_practice.group === "coach/practice");
ok("static budget is 201.6 minutes", byId.static_shell.errorBudgetMinutes === slo.errorBudgetMinutes(0.995, 28));
ok("readiness budget is 40.32 minutes", Math.abs(byId.readiness.errorBudgetMinutes - 40.32) < 1e-9);
ok("coach budget is 403.2 minutes", Math.abs(byId.coach.errorBudgetMinutes - 403.2) < 1e-9);
ok("homework p95 is 120000 ms", byId.analyse_homework.p95TargetMs === 120000);
ok("sync p95 is 3000 ms", byId.sync.p95TargetMs === 3000);
ok("readiness query does not call the model", byId.readiness.query.indexOf("must not call Anthropic") !== -1);
ok("sync query avoids row bodies", byId.sync.query.indexOf("Do not query row bodies") !== -1);
ok("admission denials are outside the error budget", report.excludedOutcomes.indexOf("not_admitted") !== -1 && report.excludedOutcomes.indexOf("rate_limited") !== -1);

console.log("slo.test.js: " + passed + " assertions passed");
