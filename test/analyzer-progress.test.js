/*
 * Permanent test harness for the Homework Analyzer's PROGRESS & PATTERN
 * analytics: anOutcome, flattenAttempts, topicMasteryOverTime,
 * accuracyComplexityTrend, errorPatternEvolution, independenceTrend,
 * approvedVsUnconfirmed.
 *
 * app.js is a browser IIFE, so these aren't exported. As with the other tests,
 * we slice the pure analytics block (delimited by __ANALYTICS_START__ /
 * __ANALYTICS_END__) out of app.js and evaluate it in a vm sandbox, so the test
 * always exercises the REAL shipped code. Zero external dependencies — run with
 * `npm test` or `node test/analyzer-progress.test.js`.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const start = appSrc.indexOf("// __ANALYTICS_START__");
const end = appSrc.indexOf("// __ANALYTICS_END__");
assert.ok(start >= 0, "could not find __ANALYTICS_START__ in app.js");
assert.ok(end > start, "could not find __ANALYTICS_END__ in app.js");
const block = appSrc.slice(start, end);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  block +
    "\n;this.__x = { anOutcome, flattenAttempts, topicMasteryOverTime, " +
    "accuracyComplexityTrend, errorPatternEvolution, independenceTrend, approvedVsUnconfirmed };",
  sandbox,
  { filename: "app.js#analyzer-progress" }
);
const {
  anOutcome, flattenAttempts, topicMasteryOverTime,
  accuracyComplexityTrend, errorPatternEvolution, independenceTrend, approvedVsUnconfirmed,
} = sandbox.__x;
assert.strictEqual(typeof topicMasteryOverTime, "function", "topicMasteryOverTime not extracted");

let passed = 0;
// Values returned from the vm sandbox live in a different realm, so their
// Array/Object prototypes differ from this realm's — deepStrictEqual would
// reject them on that basis alone. Compare by JSON value instead.
function check(desc, actual, expected) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), desc + " (got " + JSON.stringify(actual) + ")");
  passed++;
}
function ok(desc, cond) { assert.ok(cond, desc); passed++; }

// Fixture — 3 worksheets, deliberately NOT pre-sorted (getAnalyses returns
// newest-first), so analytics must sort ascending internally.
const rows = [
  { createdAt: 3000, overall: { subject: "maths", score: 90, avgComplexity: 4 }, attempts: [
    { topic: "fractions", complexity: 4, marksAwarded: 9, marksAvailable: 10, errorType: "", supportLevel: "independent", parentApproved: true }] },
  { createdAt: 1000, overall: { subject: "maths", score: 50, avgComplexity: 2 }, attempts: [
    { topic: "fractions", complexity: 2, marksAwarded: 1, marksAvailable: 2, errorType: "calculation", supportLevel: "guided", parentApproved: true },
    { topic: "", complexity: 2, marksAwarded: 0, marksAvailable: 1, errorType: "concept", supportLevel: "hint", parentApproved: false }] },
  { createdAt: 2000, overall: { subject: "maths", score: 75, avgComplexity: 3 }, attempts: [
    { topic: "fractions", complexity: 3, marksAwarded: 3, marksAvailable: 4, errorType: "", supportLevel: "independent", parentApproved: true },
    { topic: "decimals", complexity: 3, marksAwarded: null, marksAvailable: null, errorType: "", supportLevel: "independent", parentApproved: false }] },
];

// ---- anOutcome ----
check("full marks → correct", anOutcome({ marksAwarded: 2, marksAvailable: 2 }), "correct");
check("zero marks → incorrect", anOutcome({ marksAwarded: 0, marksAvailable: 2 }), "incorrect");
check("partial marks → partial", anOutcome({ marksAwarded: 1, marksAvailable: 2 }), "partial");
check("no marks → unmarked", anOutcome({ marksAwarded: null, marksAvailable: null }), "unmarked");

// ---- empty / null safety on every function ----
check("flattenAttempts(null) → []", flattenAttempts(null), []);
check("topicMasteryOverTime([]) → []", topicMasteryOverTime([]), []);
check("accuracyComplexityTrend(null) → []", accuracyComplexityTrend(null), []);
check("errorPatternEvolution([]) → []", errorPatternEvolution([]), []);
check("independenceTrend(null) empty shape", independenceTrend(null),
  { series: [], firstPct: null, lastPct: null, delta: null, direction: null });
check("approvedVsUnconfirmed([]) zeros", approvedVsUnconfirmed([]), { approved: 0, unconfirmed: 0, total: 0 });

// ---- flattenAttempts: one item per attempt; empty topic → "general" ----
(function () {
  const flat = flattenAttempts(rows);
  check("flattenAttempts yields 5 attempts", flat.length, 5);
  ok("empty topic bucketed under general", flat.some((a) => a.topic === "general"));
})();

// ---- topicMasteryOverTime ----
(function () {
  const topics = topicMasteryOverTime(rows);
  const fr = topics.find((t) => t.topic === "fractions");
  const dec = topics.find((t) => t.topic === "decimals");
  const gen = topics.find((t) => t.topic === "general");
  check("fractions pct is marks-aware (13/16 → 81)", fr.pct, 81);
  check("fractions series ascending pct", fr.series.map((p) => p.pct), [50, 75, 90]);
  check("fractions delta = last-first", fr.delta, 40);
  ok("fractions delta positive (improving)", fr.delta > 0);
  check("fractions total counts all attempts", fr.total, 3);
  check("decimals total counts null-marks attempt", dec.total, 1);
  check("decimals pct null (no marks available)", dec.pct, null);
  check("general topic total", gen.total, 1);
  check("sorted by total desc (fractions first)", topics[0].topic, "fractions");
})();

// ---- topN cap ----
(function () {
  const capped = topicMasteryOverTime(rows, { topN: 1 });
  check("topN caps returned topics", capped.length, 1);
})();

// ---- accuracyComplexityTrend ----
(function () {
  const tr = accuracyComplexityTrend(rows);
  check("trend ascending by t", tr.map((p) => p.t), [1000, 2000, 3000]);
  check("scorePct uses overall.score", tr.map((p) => p.scorePct), [50, 75, 90]);
  check("attempted counts per worksheet", tr.map((p) => p.attempted), [2, 2, 1]);
})();

// ---- errorPatternEvolution ----
(function () {
  const errs = errorPatternEvolution(rows);
  check("two qualifying error types", errs.length, 2);
  const calc = errs.find((e) => e.key === "calculation");
  check("calculation total", calc.total, 1);
  check("calculation fades (earlier only)", calc.trend, "fading");
})();

// ---- independenceTrend ----
(function () {
  const ind = independenceTrend(rows);
  check("independence series pct 0→100→100", ind.series.map((p) => p.independentPct), [0, 100, 100]);
  check("independence direction rising", ind.direction, "rising");
  check("independence delta", ind.delta, 100);
})();

// ---- approvedVsUnconfirmed ----
check("approved vs unconfirmed counts", approvedVsUnconfirmed(rows),
  { approved: 3, unconfirmed: 2, total: 5 });

console.log("analyzer-progress.test.js: " + passed + " assertions passed");
