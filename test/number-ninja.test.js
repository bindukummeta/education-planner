/*
 * Permanent test harness for the Number Ninja game's pure logic:
 *   ninjaInt, ninjaWeight, pickNinjaCat, buildNinjaQuestion, ninjaOptions,
 *   buildNinjaRound (plus NINJA_CATS / NINJA_MASTER_AT).
 *
 * app.js is a browser IIFE, so these aren't exported. As with the other game
 * tests, we slice the relevant source out of app.js and evaluate it in a vm
 * sandbox, so the test always exercises the REAL shipped code. The Ninja helpers
 * depend on shuffleArr (defined in the Vocab block), so that slice is included
 * too. Zero external dependencies — run with `npm test` or
 * `node test/number-ninja.test.js`.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// Slice 1: shuffleArr (a pure dependency of ninjaOptions), lifted on its own.
const shufStart = appSrc.indexOf("function shuffleArr(arr, rng) {");
assert.ok(shufStart >= 0, "could not find shuffleArr in app.js");
const shufEnd = appSrc.indexOf("function vocabWeight", shufStart);
assert.ok(shufEnd > shufStart, "could not find shuffleArr boundary in app.js");
const shufBlock = appSrc.slice(shufStart, shufEnd);

// Slice 2: the Number Ninja pure helpers, contiguous from the first constant to
// the async loadNinjaMastery boundary (which touches EduStore and isn't pure).
const ninjaStart = appSrc.indexOf("const NINJA_ROUND_LEN =");
const ninjaEnd = appSrc.indexOf("async function loadNinjaMastery");
assert.ok(ninjaStart >= 0, "could not find NINJA_ROUND_LEN in app.js");
assert.ok(ninjaEnd > ninjaStart, "could not find loadNinjaMastery boundary in app.js");
const ninjaBlock = appSrc.slice(ninjaStart, ninjaEnd);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  shufBlock + "\n" + ninjaBlock +
    "\n;this.__x = { NINJA_CATS, NINJA_MASTER_AT, ninjaInt, ninjaWeight, " +
    "pickNinjaCat, buildNinjaQuestion, ninjaOptions, buildNinjaRound };",
  sandbox,
  { filename: "app.js#number-ninja" }
);
const {
  NINJA_CATS, NINJA_MASTER_AT, ninjaInt, ninjaWeight,
  pickNinjaCat, buildNinjaQuestion, ninjaOptions, buildNinjaRound,
} = sandbox.__x;
assert.ok(Array.isArray(NINJA_CATS) && NINJA_CATS.length === 6, "NINJA_CATS not extracted");
assert.strictEqual(typeof buildNinjaRound, "function", "buildNinjaRound not extracted");

let passed = 0;
function check(desc, actual, expected) {
  assert.deepStrictEqual(actual, expected, desc + " (got " + JSON.stringify(actual) + ")");
  passed++;
}
function ok(desc, cond) { assert.ok(cond, desc); passed++; }
// Small seeded PRNG (mulberry32) so "given rng" behaviour is deterministic.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- ninjaInt: within bounds ----
(function () {
  const rng = mulberry32(1);
  let inRange = true;
  for (let i = 0; i < 500; i++) { const v = ninjaInt(rng, 3, 9); if (v < 3 || v > 9) inRange = false; }
  ok("ninjaInt stays within [lo, hi]", inRange);
})();

// ---- ninjaWeight: mastered weighs far less than new, never zero ----
ok("new category weighs most", ninjaWeight({ seen: 0, correct: 0 }) > ninjaWeight({ seen: 3, correct: 3 }));
ok("mastered category still has non-zero weight",
  ninjaWeight({ seen: 9, correct: NINJA_MASTER_AT }) > 0);
ok("mastered weighs less than a partly-learned one",
  ninjaWeight({ seen: 9, correct: NINJA_MASTER_AT }) < ninjaWeight({ seen: 2, correct: 2 }));

// ---- pickNinjaCat: always a valid category; deterministic given rng ----
(function () {
  const rng = mulberry32(7);
  let allValid = true;
  for (let i = 0; i < 200; i++) { if (NINJA_CATS.indexOf(pickNinjaCat({}, rng)) < 0) allValid = false; }
  ok("pickNinjaCat only returns known categories", allValid);
  const a = pickNinjaCat({}, mulberry32(55));
  const b = pickNinjaCat({}, mulberry32(55));
  check("pickNinjaCat is deterministic given rng", a, b);
})();

// ---- buildNinjaQuestion: shape + arithmetic correctness for every category ----
(function () {
  const rng = mulberry32(42);
  NINJA_CATS.forEach((cat) => {
    for (let i = 0; i < 50; i++) {
      const q = buildNinjaQuestion(cat, rng);
      ok(cat + " q has 4 options", q.options.length === 4);
      ok(cat + " options are unique", new Set(q.options).size === 4);
      ok(cat + " options include the answer", q.options.indexOf(q.answer) >= 0);
      ok(cat + " answer is an integer", Number.isInteger(q.answer));
      ok(cat + " prompt is a non-empty string", typeof q.prompt === "string" && q.prompt.length > 0);
      ok(cat + " question keeps its category", q.cat === cat);
    }
  });
})();

// ---- divide: always exact (whole-number answer, verified by re-multiplying) ----
(function () {
  const rng = mulberry32(11);
  let allExact = true;
  for (let i = 0; i < 200; i++) {
    const q = buildNinjaQuestion("divide", rng);
    const parts = q.prompt.split(" ÷ ");
    if (Number(parts[0]) / Number(parts[1]) !== q.answer) allExact = false;
  }
  ok("division questions are always exact", allExact);
})();

// ---- negatives: the answer really is negative ----
(function () {
  const rng = mulberry32(21);
  let allNeg = true;
  for (let i = 0; i < 200; i++) { if (buildNinjaQuestion("negatives", rng).answer >= 0) allNeg = false; }
  ok("negative-number questions have a negative answer", allNeg);
})();

// ---- ninjaOptions: 4 unique options including the answer ----
(function () {
  const rng = mulberry32(3);
  const opts = ninjaOptions(48, rng);
  check("ninjaOptions returns 4 options", opts.length, 4);
  check("ninjaOptions options are unique", new Set(opts).size, 4);
  ok("ninjaOptions includes the answer", opts.indexOf(48) >= 0);
})();

// ---- buildNinjaRound: count honoured + deterministic given rng ----
(function () {
  const r = buildNinjaRound(10, mulberry32(99));
  check("round honours requested count", r.length, 10);
  const a = buildNinjaRound(8, mulberry32(123), {});
  const b = buildNinjaRound(8, mulberry32(123), {});
  check("same seed produces identical round", JSON.stringify(a), JSON.stringify(b));
})();

// ---- mastery weighting: weak categories appear more than mastered ones ----
(function () {
  // Master all but one category; over many single-question rounds the un-mastered
  // category should dominate the picks (it weighs far more than the rest).
  const mastery = {};
  NINJA_CATS.forEach((c, i) => { if (i > 0) mastery[c] = { seen: 9, correct: 9 }; });
  const weak = NINJA_CATS[0];
  const rng = mulberry32(2024);
  let weakHits = 0;
  const trials = 3000;
  for (let i = 0; i < trials; i++) { if (buildNinjaRound(1, rng, mastery)[0].cat === weak) weakHits++; }
  ok("weak category is chosen far more than mastered ones (" +
    Math.round((weakHits / trials) * 100) + "%)", weakHits / trials > 0.5);
})();

console.log("number-ninja.test.js: " + passed + " assertions passed");
