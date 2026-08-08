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
    "accuracyComplexityTrend, errorPatternEvolution, independenceTrend, approvedVsUnconfirmed, " +
    "normalizeAnswer, answerToNumber, answersMatch, blindSpotGroups, mathsNinjaCatForGroup, " +
    "expectedComplexityForYear, standardComparison, " +
    "mockTargetProfile, gapToTarget, pacingStatus, " +
    "sortStudents, resolveActiveStudent, studentInitial, studentColor, " +
    "levelScore, subjectLevel, schoolLevelBreakdown, cxToLevel, accToLevel, levelStatus, groupBySubject, roundHalf };",
  sandbox,
  { filename: "app.js#analyzer-progress" }
);
const {
  anOutcome, flattenAttempts, topicMasteryOverTime,
  accuracyComplexityTrend, errorPatternEvolution, independenceTrend, approvedVsUnconfirmed,
  normalizeAnswer, answerToNumber, answersMatch, blindSpotGroups, mathsNinjaCatForGroup,
  expectedComplexityForYear, standardComparison,
  mockTargetProfile, gapToTarget, pacingStatus,
  sortStudents, resolveActiveStudent, studentInitial, studentColor,
  levelScore, subjectLevel, schoolLevelBreakdown, cxToLevel, accToLevel, levelStatus, groupBySubject, roundHalf,
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

// ---- expectedComplexityForYear ----
(function () {
  check("Reception band 1-2", expectedComplexityForYear("reception"), { min: 1, max: 2, mid: 1.5 });
  check("Y3 band 2-3", expectedComplexityForYear("y3"), { min: 2, max: 3, mid: 2.5 });
  check("Y6 band 3-4", expectedComplexityForYear("y6"), { min: 3, max: 4, mid: 3.5 });
  check("Y8 band 3-4 (KS3)", expectedComplexityForYear("y8"), { min: 3, max: 4, mid: 3.5 });
  check("Y11 band 4-5", expectedComplexityForYear("y11"), { min: 4, max: 5, mid: 4.5 });
  check("case-insensitive", expectedComplexityForYear("Y6"), { min: 3, max: 4, mid: 3.5 });
  check("blank -> null", expectedComplexityForYear(""), null);
  check("unknown -> null", expectedComplexityForYear("nursery"), null);
})();

// ---- standardComparison ----
(function () {
  // Fixture recent avg complexity (last 3 worksheets ascending): (2+3+4)/3 = 3.0.
  check("no year -> null", standardComparison(rows, ""), null);
  // Y6 band is 3-4; recentAvg 3.0 sits within.
  check("Y6 within band", standardComparison(rows, "y6"),
    { status: "within", recentAvg: 3, band: { min: 3, max: 4, mid: 3.5 }, worksheetsUsed: 3 });
  // Y11 band is 4-5; recentAvg 3.0 is below.
  check("Y11 below band", standardComparison(rows, "y11"),
    { status: "below", recentAvg: 3, band: { min: 4, max: 5, mid: 4.5 }, worksheetsUsed: 3 });
  // Reception band is 1-2; recentAvg 3.0 is above.
  check("Reception above band", standardComparison(rows, "reception"),
    { status: "above", recentAvg: 3, band: { min: 1, max: 2, mid: 1.5 }, worksheetsUsed: 3 });
  // No complexity recorded -> null.
  check("no complexity -> null", standardComparison(
    [{ createdAt: 1, overall: { subject: "maths" }, attempts: [{ topic: "x" }] }], "y6"), null);
  // recentN limits how many worksheets feed the average: last 1 = avg 4 -> within Y11.
  check("recentN=1 uses latest only", standardComparison(rows, "y11", { recentN: 1 }),
    { status: "within", recentAvg: 4, band: { min: 4, max: 5, mid: 4.5 }, worksheetsUsed: 1 });
})();

// ---- Gap-to-Target: mockTargetProfile ----
(function () {
  check("mockTargetProfile([]) -> null", mockTargetProfile([]), null);
  const mocks = [
    { createdAt: 1000, overall: { subject: "maths", score: 80 }, attempts: [
      { topic: "fractions", complexity: 3, marksAwarded: 8, marksAvailable: 10 },
      { topic: "fractions", complexity: 4, marksAwarded: 8, marksAvailable: 10 }] },
    { createdAt: 2000, overall: { subject: "maths", score: 70 }, attempts: [
      { topic: "decimals", complexity: 4, marksAwarded: 7, marksAvailable: 10 },
      { topic: "algebra", complexity: 5, marksAwarded: 7, marksAvailable: 10 }] },
  ];
  // Complexities [3,4,4,5] (<5 samples) -> min 3, max 5, mid avg 4. Weights sum 1.
  check("mockTargetProfile derives band + weights + passMark", mockTargetProfile(mocks), {
    complexityBand: { min: 3, max: 5, mid: 4 },
    topics: [{ topic: "fractions", weight: 0.5 }, { topic: "decimals", weight: 0.25 }, { topic: "algebra", weight: 0.25 }],
    passMark: 75, sampleCount: 2,
  });
  const prof = mockTargetProfile(mocks);
  const wsum = prof.topics.reduce((s, t) => s + t.weight, 0);
  check("topic weights sum ~1", wsum, 1);
  // No complexity recorded -> null.
  check("mockTargetProfile no complexity -> null",
    mockTargetProfile([{ createdAt: 1, overall: { subject: "maths", score: 50 }, attempts: [{ topic: "x" }] }]), null);
})();

// ---- Gap-to-Target: gapToTarget ----
(function () {
  const prof = { complexityBand: { min: 3, max: 4, mid: 3.5 }, topics: [{ topic: "fractions", weight: 0.6 }, { topic: "decimals", weight: 0.4 }], passMark: 70, sampleCount: 2 };
  check("gapToTarget(no profile) -> null", gapToTarget([{ createdAt: 1, overall: {}, attempts: [] }], null, {}), null);
  // Complexity status ladder (neutral vocab only).
  const hwLow = [{ createdAt: 1, overall: { subject: "maths", avgComplexity: 2 }, attempts: [] }];
  const hwMid = [{ createdAt: 1, overall: { subject: "maths", avgComplexity: 3.5 }, attempts: [] }];
  const hwHigh = [{ createdAt: 1, overall: { subject: "maths", avgComplexity: 5 }, attempts: [] }];
  check("below band -> building", gapToTarget(hwLow, prof, {}).complexity.status, "building");
  check("within band -> meeting", gapToTarget(hwMid, prof, {}).complexity.status, "meeting");
  check("above band -> exceeding", gapToTarget(hwHigh, prof, {}).complexity.status, "exceeding");
  check("complexity gap = recent - mid", gapToTarget(hwLow, prof, {}).complexity.gap, -1.5);
  // Topics: met / weak / missing.
  const profT = { complexityBand: { min: 2, max: 4, mid: 3 }, topics: [{ topic: "fractions", weight: 0.4 }, { topic: "decimals", weight: 0.3 }, { topic: "algebra", weight: 0.3 }], passMark: 70, sampleCount: 1 };
  const hwT = [{ createdAt: 1, overall: { subject: "maths" }, attempts: [
    { topic: "fractions", complexity: 3, marksAwarded: 9, marksAvailable: 10 },
    { topic: "decimals", complexity: 3, marksAwarded: 2, marksAvailable: 10 }] }];
  check("topics met/weak/missing", gapToTarget(hwT, profT, {}).topics,
    { missing: ["algebra"], weak: ["decimals"], met: ["fractions"] });
  // Accuracy: gap sign + status against passMark.
  const hwAcc = [{ createdAt: 1, overall: { subject: "maths", score: 85, avgComplexity: 3.5 }, attempts: [] }];
  check("accuracy gap + status", gapToTarget(hwAcc, prof, {}).accuracy,
    { recent: 85, passMark: 70, gap: 15, status: "exceeding" });
  // Empty homework -> neutral, verdict-free shape (no overallStatus).
  check("empty homework -> enoughData false, no verdict", gapToTarget([], prof, {}), {
    complexity: { recent: null, target: 3.5, gap: null },
    topics: { missing: ["fractions", "decimals"], weak: [], met: [] },
    accuracy: { recent: null, passMark: 70, gap: null },
    enoughData: false,
  });
})();

// ---- Gap-to-Target: pacingStatus ----
(function () {
  const a = pacingStatus({ gap: 10, daysRemaining: 70, deltaPerWeek: 2 });
  check("comfortable rate -> onPace", a.onPace, true);
  const b = pacingStatus({ gap: 20, daysRemaining: 7, deltaPerWeek: 1 });
  check("tight rate -> not onPace", b.onPace, false);
  ok("onPace label has no deficit words", !/behind|fail|weak|struggl|bad|worst/i.test(a.label));
  ok("building label has no deficit words", !/behind|fail|weak|struggl|bad|worst/i.test(b.label));
})();

// ---- Levels (0–10) ----
(function () {
  check("cxToLevel(1)=0", cxToLevel(1), 0);
  check("cxToLevel(5)=10", cxToLevel(5), 10);
  check("cxToLevel(3.5)=6.25", cxToLevel(3.5), 6.25);
  check("accToLevel(70)=7", accToLevel(70), 7);
  check("accToLevel(null)=null", accToLevel(null), null);
  // Re-normalisation: missing accuracy shifts weight onto the rest, not to 0.
  ok("levelScore re-normalises when a component is null", levelScore({ complexity: 5, accuracy: null, coverage: 5 }) === 5);
  check("levelStatus meeting", levelStatus(7.5, 7.5), "meeting");
  check("levelStatus exceeding", levelStatus(9, 7.5), "exceeding");
  check("levelStatus getting there", levelStatus(7, 7.5), "getting there");
  check("levelStatus building", levelStatus(4, 7.5), "building");
  ok("level statuses use only neutral vocab",
    !/behind|fail|weak|struggl|bad|poor|slow|worst/i.test([
      levelStatus(9,7.5), levelStatus(7.5,7.5), levelStatus(7,7.5), levelStatus(4,7.5)].join(" ")));

  var prof = { complexityBand: { min: 3, max: 4, mid: 3.5 }, topics: [{ topic: "fractions", weight: 0.5 }, { topic: "decimals", weight: 0.5 }], passMark: 70, sampleCount: 2 };
  // Full mastery: recentCx=mid, acc=passMark, all topics met -> current == target.
  var hwFull = [{ createdAt: 1, overall: { subject: "maths", score: 70, avgComplexity: 3.5 }, attempts: [
    { topic: "fractions", complexity: 3, marksAwarded: 7, marksAvailable: 10 },
    { topic: "decimals", complexity: 3, marksAwarded: 7, marksAvailable: 10 }] }];
  var sl = subjectLevel(hwFull, prof);
  check("full mastery current==target", sl.current, sl.target);
  check("full mastery lands at target 7.5", sl.current, 7.5);
  check("full mastery status meeting", sl.status, "meeting");
  // Empty homework -> current null, enoughData false, target still numeric.
  var slEmpty = subjectLevel([], prof);
  check("empty hw -> current null", slEmpty.current, null);
  ok("empty hw -> enoughData false", slEmpty.enoughData === false);
  ok("empty hw -> target is a number", typeof slEmpty.target === "number");
  // Monotonicity: higher accuracy never lowers the level (same cx/topics).
  var mk = function (score) { return [{ createdAt: 1, overall: { subject: "maths", score: score, avgComplexity: 3.5 }, attempts: [
    { topic: "fractions", complexity: 3, marksAwarded: 7, marksAvailable: 10 },
    { topic: "decimals", complexity: 3, marksAwarded: 7, marksAvailable: 10 }] }]; };
  ok("higher accuracy >= lower accuracy level", subjectLevel(mk(90), prof).current >= subjectLevel(mk(60), prof).current);
  // Tiffin-style worked example: high band + high pass mark.
  var tiffin = { complexityBand: { min: 4, max: 5, mid: 4.2 }, topics: [{ topic: "fractions", weight: 0.5 }, { topic: "algebra", weight: 0.5 }], passMark: 80, sampleCount: 3 };
  var tHw = [{ createdAt: 1, overall: { subject: "maths", score: 65, avgComplexity: 3.5 }, attempts: [
    { topic: "fractions", complexity: 3, marksAwarded: 9, marksAvailable: 10 }] }];
  var tsl = subjectLevel(tHw, tiffin);
  check("Tiffin target 8.5", tsl.target, 8.5);
  check("Tiffin current 6", tsl.current, 6);
  check("Tiffin status building", tsl.status, "building");
  // groupBySubject + schoolLevelBreakdown overall = mean of subjects.
  var g = groupBySubject([{ overall: { subject: "maths" } }, { overall: { subject: "english" } }, { overall: { subject: "maths" } }]);
  check("groupBySubject buckets", [g.maths.length, g.english.length], [2, 1]);
  var bd = schoolLevelBreakdown({ maths: { homeworkRows: hwFull, profile: prof }, english: { homeworkRows: mk(60), profile: prof } });
  check("breakdown has 2 subject rows", bd.subjects.length, 2);
  var expected = roundHalf((bd.subjects[0].current + bd.subjects[1].current) / 2);
  check("overall current = mean of subjects", bd.overall.current, expected);
})();

// ---- Practice: normalizeAnswer / answerToNumber / answersMatch ----
(function () {
  check("normalizeAnswer trims/lowercases/collapses/strips", normalizeAnswer("  The  Answer.  "), "the answer");
  check("normalizeAnswer(null) -> ''", normalizeAnswer(null), "");
  check("answerToNumber integer", answerToNumber(" 42 "), 42);
  check("answerToNumber decimal", answerToNumber("0.5"), 0.5);
  check("answerToNumber fraction", answerToNumber("1/2"), 0.5);
  check("answerToNumber non-number -> null", answerToNumber("cat"), null);
  check("answerToNumber divide-by-zero -> null", answerToNumber("1/0"), null);
  ok("answersMatch exact after normalize", answersMatch("Paris.", "  paris "));
  ok("answersMatch fraction vs decimal", answersMatch("1/2", "0.5"));
  ok("answersMatch numeric with spaces", answersMatch(" 42 ", "42"));
  ok("answersMatch rejects different", !answersMatch("dog", "cat"));
})();

// ---- Practice: blindSpotGroups ----
(function () {
  check("blindSpotGroups([]) -> []", blindSpotGroups([]), []);
  const bs = [
    { createdAt: 1000, overall: { subject: "maths" }, attempts: [
      { questionText: "1/2 + 1/4 = ?", expectedAnswer: "3/4", topic: "fractions", errorType: "calculation", marksAwarded: 0, marksAvailable: 1 },
      { questionText: "Add fractions", expectedAnswer: null, topic: "fractions", errorType: "concept", marksAwarded: 1, marksAvailable: 2 }] },
    { createdAt: 2000, overall: { subject: "maths" }, attempts: [
      { questionText: "1/2 + 1/4 = ?", expectedAnswer: "3/4", topic: "fractions", errorType: "calculation", marksAwarded: 0, marksAvailable: 1 },
      { questionText: "2 + 2 = ?", expectedAnswer: "4", topic: "general", errorType: "", marksAwarded: 2, marksAvailable: 2 }] },
  ];
  const groups = blindSpotGroups(bs);
  check("only wrong questions bucketed (2 groups)", groups.length, 2);
  const calc = groups.find((g) => g.errorType === "calculation");
  check("frequent bucket first", groups[0].errorType, "calculation");
  check("repeated question deduped", calc.uniqueCount, 1);
  check("dedup keeps count of all occurrences", calc.count, 2);
  check("empty errorType -> 'other' key", !!groups.find((g) => g.errorType === "concept"), true);
  ok("correct question (2+2) excluded", !groups.some((g) => g.questions.some((q) => q.questionText === "2 + 2 = ?")));
})();

// ---- Practice Phase 2: mathsNinjaCatForGroup ----
(function () {
  const g = (subject, topic, texts) => ({
    subject: subject, topic: topic,
    questions: (texts || []).map((t) => ({ questionText: t })),
  });
  check("non-maths subject -> null", mathsNinjaCatForGroup(g("english", "arithmetic", ["2 + 2"])), null);
  check("null group -> null", mathsNinjaCatForGroup(null), null);
  check("fractions topic -> null (not generable)", mathsNinjaCatForGroup(g("maths", "fractions", ["1/2 + 1/4"])), null);
  check("geometry topic -> null", mathsNinjaCatForGroup(g("maths", "geometry", ["area of triangle"])), null);
  check("money topic -> null", mathsNinjaCatForGroup(g("maths", "money", ["£3 + £5"])), null);
  check("addition sniffed -> add", mathsNinjaCatForGroup(g("maths", "arithmetic", ["12 + 5 = ?", "40 + 9 = ?"])), "add");
  check("subtraction sniffed -> subtract", mathsNinjaCatForGroup(g("maths", "arithmetic", ["12 − 5 = ?"])), "subtract");
  check("multiply sniffed -> multiply", mathsNinjaCatForGroup(g("maths", "arithmetic", ["12 × 5 = ?"])), "multiply");
  check("divide sniffed -> divide", mathsNinjaCatForGroup(g("maths", "arithmetic", ["12 ÷ 4 = ?"])), "divide");
  check("chained ops -> bodmas", mathsNinjaCatForGroup(g("maths", "arithmetic", ["3 + 4 × 2 = ?"])), "bodmas");
  check("arithmetic worded (no operator) -> add", mathsNinjaCatForGroup(g("maths", "arithmetic", ["What is twelve and five altogether?"])), "add");
  check("general topic, no operator -> null", mathsNinjaCatForGroup(g("maths", "general", ["Estimate the total"])), null);
  check("general topic with operator -> op", mathsNinjaCatForGroup(g("maths", "general", ["23 × 4 = ?"])), "multiply");
})();

// ---- Student profile helpers ----
(function () {
  const list = [
    { id: "b", name: "Zara", order: 2 },
    { id: "a", name: "Amir", order: 1 },
  ];
  // sortStudents: order first
  check("sortStudents orders by order field", sortStudents(list).map((s) => s.id), ["a", "b"]);
  // tie on order -> name
  check(
    "sortStudents tie-breaks on name",
    sortStudents([{ id: "x", name: "Bo", order: 1 }, { id: "y", name: "Al", order: 1 }]).map((s) => s.id),
    ["y", "x"]
  );
  ok("sortStudents does not mutate input", list[0].id === "b");
  check("sortStudents([]) -> []", sortStudents([]), []);
  check("sortStudents(undefined) -> []", sortStudents(undefined), []);

  // resolveActiveStudent
  check("resolveActiveStudent picks matching id", resolveActiveStudent(list, "b").id, "b");
  check("resolveActiveStudent missing id -> first sorted", resolveActiveStudent(list, "nope").id, "a");
  ok("resolveActiveStudent([]) -> null", resolveActiveStudent([], "x") === null);

  // studentInitial
  check("studentInitial uppercases first char", studentInitial({ name: "leo" }), "L");
  check("studentInitial trims leading space", studentInitial({ name: "  ada" }), "A");
  check("studentInitial empty name -> ?", studentInitial({ name: "" }), "?");
  check("studentInitial no student -> ?", studentInitial(null), "?");

  // studentColor
  ok("studentColor deterministic for same id", studentColor({ id: "abc" }) === studentColor({ id: "abc" }));
  ok("studentColor returns a hex from palette", /^#[0-9a-f]{6}$/.test(studentColor({ id: "abc" })));
  ok("studentColor falls back to name when no id", typeof studentColor({ name: "Zara" }) === "string");
})();

console.log("analyzer-progress.test.js: " + passed + " assertions passed");
