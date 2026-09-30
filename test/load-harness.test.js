"use strict";
const assert = require("assert");
const path = require("path");
const { spawnSync } = require("child_process");
const harness = require(path.join(__dirname, "..", "scripts", "load-harness.js"));

let passed = 0;
function ok(desc, cond) { assert.ok(cond, desc); passed++; }

ok("p50 of four samples is the second", harness.percentile([10, 20, 30, 40], 50) === 20);
ok("p95 and p99 use the nearest rank", harness.percentile([10, 20, 30, 40], 95) === 40 && harness.percentile([10, 20, 30, 40], 99) === 40);
const summary = harness.summarize([{ ok: true, ms: 10 }, { ok: false, ms: 99 }, { ok: true, ms: 30 }]);
ok("summary counts errors and percentiles", summary.count === 3 && summary.errors === 1 && summary.p50 === 10 && summary.p95 === 30);
ok("ci may run smoke only", harness.profileAllowed("smoke", { CI: "true" }) === true && harness.profileAllowed("heavy", { CI: "true" }) === false && harness.profileAllowed("soak", { CI: "1" }) === false);

(async function () {
  const report = await harness.runProfile("smoke", { env: {} });
  ok("smoke uses a fake provider", report.provider === "fake" && report.network === "blocked" && report.data === "synthetic");
  ["static_shell", "readiness", "sync", "coach", "generate_practice", "analyse_homework"].forEach((name) => {
    const row = report.scenarios[name];
    ok(name + " reports p50 p95 p99 and errors", row && typeof row.p50 === "number" && typeof row.p95 === "number" && typeof row.p99 === "number" && row.errors === 0 && row.pass === true);
  });
  ok("smoke meets the thresholds", report.ok === true);

  let blocked = false;
  try {
    await harness.runProfile("heavy", { env: { CI: "true" } });
  } catch (err) { blocked = err && err.code === "ci_smoke_only"; }
  ok("ci refuses the heavy profile", blocked === true);

  const cli = spawnSync(process.execPath, ["scripts/load-harness.js", "--profile", "heavy"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: Object.assign({}, process.env, { CI: "true" }),
  });
  ok("the cli refuses heavy work on ci", cli.status === 2 && cli.stderr.indexOf("smoke profile only") !== -1);

  console.log("load-harness.test.js: " + passed + " assertions passed");
})().catch((err) => { console.error(err); process.exit(1); });
