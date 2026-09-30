"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const cost = require(path.join(__dirname, "..", "scripts", "cost-model.js"));

let passed = 0;
function ok(desc, cond) { assert.ok(cond, desc); passed++; }

const sample = JSON.parse(fs.readFileSync(cost.SAMPLE_PATH, "utf8"));
ok("sample assumptions are labelled non-pricing", sample.assumptionClass === "non-pricing" && sample.prices === null);
ok("sample is the 5000-user model", sample.registeredUsers === 5000);
ok("sample file does not embed a dollar price", !/\$\s*\d/.test(fs.readFileSync(cost.SAMPLE_PATH, "utf8")));

const unpaid = cost.evaluate(sample);
ok("missing prices do not invent a total", unpaid.cost === null && unpaid.breakEvenUsdPerActiveFamily === null && unpaid.pricesInvented === false);
ok("sample volumes still resolve", unpaid.activeFamilies === 1000 && unpaid.registeredUsers === 5000);
ok("sample reports the beta cap gap", unpaid.quota.registeredUsersAboveCap === 4800 && unpaid.quota.betaAdmissionCap === 200 && unpaid.quota.cohortMinDocumented === 50);

const priced = cost.evaluate({
  assumptionClass: "non-pricing",
  registeredUsers: 5000,
  activeFamilyPercent: 10,
  callsPerActiveFamily: { coach: 2, "generate-practice": 0, "analyse-homework": 1 },
  homeworkPagesPerCall: 2,
  tokens: {
    coach: { input: 1000, output: 500 },
    "generate-practice": { input: 1000, output: 500 },
    "analyse-homework": { inputPerPage: 1000, output: 200 },
  },
  storageGbPerActiveFamily: 0.01,
  readinessProbesPerMonth: 0,
  prices: {
    anthropic: { inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 4 },
    vercel: { baseMonthlyUsd: 20, includedFunctionInvocations: 1000, invocationOverageUsdPerMillion: 10 },
    supabase: { baseMonthlyUsd: 25, includedStorageGb: 1, storageOverageUsdPerGb: 3 },
  },
});
ok("fixture prices are applied, not invented", priced.pricesClass === "user-supplied" && priced.pricesInvented === false);
ok("anthropic total matches the token formula", Math.abs(priced.cost.anthropicUsd - 6.4) < 1e-9);
ok("vercel total matches base plus overage", Math.abs(priced.cost.vercelUsd - 20.005) < 1e-9);
ok("supabase total matches base plus storage", Math.abs(priced.cost.supabaseUsd - 37) < 1e-9);
ok("break-even is cost per active family", Math.abs(priced.breakEvenUsdPerActiveFamily - (63.405 / 500)) < 1e-9 && priced.cost.costPerActiveFamilyUsd === priced.breakEvenUsdPerActiveFamily);
ok("modelled calls sit inside the monthly quota ceiling", priced.quota.withinMonthlyCeiling === true && priced.quota.perFamilyMonthlyCeilings.coach === 1200);
ok("active families above the beta cap are reported", priced.quota.activeFamiliesAboveCap === 300);

const omitted = Object.assign({}, sample);
delete omitted.registeredUsers;
ok("omitted registered users still mean 5000", cost.evaluate(omitted).registeredUsers === 5000);

let rejected = false;
try {
  cost.evaluate(Object.assign({}, sample, { prices: { anthropic: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } } }));
} catch (err) { rejected = err && err.code === "invalid_model"; }
ok("partial prices are rejected", rejected === true);

const root = path.join(__dirname, "..");
const sampleRun = spawnSync(process.execPath, ["scripts/cost-model.js"], { cwd: root, encoding: "utf8" });
ok("sample command exits without a cost", sampleRun.status === 0 && sampleRun.stdout.indexOf('"cost": null') !== -1);
const required = spawnSync(process.execPath, ["scripts/cost-model.js", "--require-prices"], { cwd: root, encoding: "utf8" });
ok("required prices fail closed", required.status === 2 && required.stderr.indexOf("were not invented") !== -1);

console.log("cost-model.test.js: " + passed + " assertions passed");
