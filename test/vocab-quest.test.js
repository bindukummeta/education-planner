/*
 * Permanent test harness for the Vocabulary Quest game's pure logic:
 *   VOCAB_WORDS (word bank), buildVocabQuiz(words, count, rng).
 *
 * app.js is a browser IIFE, so these aren't exported. As with heuristics.test.js,
 * we slice the relevant source out of app.js and evaluate it in a vm sandbox, so
 * the test always exercises the REAL shipped code. Zero external dependencies —
 * run with `npm test` or `node test/vocab-quest.test.js`.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// Slice 1: the VOCAB_WORDS array literal (from its declaration to its closer).
const wordsStart = appSrc.indexOf("const VOCAB_WORDS = [");
assert.ok(wordsStart >= 0, "could not find VOCAB_WORDS in app.js");
const wordsClose = appSrc.indexOf("\n  ];", wordsStart);
assert.ok(wordsClose > wordsStart, "could not find end of VOCAB_WORDS");
const wordsBlock = appSrc.slice(wordsStart, wordsClose + "\n  ];".length);

// Slice 2: shuffleArr + buildVocabQuiz (contiguous, up to openVocabQuest).
const fnStart = appSrc.indexOf("function shuffleArr(arr, rng) {");
const fnEnd = appSrc.indexOf("function openVocabQuest");
assert.ok(fnStart >= 0, "could not find shuffleArr in app.js");
assert.ok(fnEnd > fnStart, "could not find openVocabQuest boundary in app.js");
const fnBlock = appSrc.slice(fnStart, fnEnd);

// Evaluate both slices together, then expose what we need.
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  wordsBlock + "\n" + fnBlock +
    "\n;this.__x = { VOCAB_WORDS, shuffleArr, buildVocabQuiz };",
  sandbox,
  { filename: "app.js#vocab-quest" }
);
const { VOCAB_WORDS, shuffleArr, buildVocabQuiz } = sandbox.__x;
assert.ok(Array.isArray(VOCAB_WORDS), "VOCAB_WORDS not extracted");
assert.strictEqual(typeof shuffleArr, "function", "shuffleArr not extracted");
assert.strictEqual(typeof buildVocabQuiz, "function", "buildVocabQuiz not extracted");

let passed = 0;
function check(desc, actual, expected) {
  assert.deepStrictEqual(actual, expected, desc + " (got " + JSON.stringify(actual) + ")");
  passed++;
}
function ok(desc, cond) {
  assert.ok(cond, desc);
  passed++;
}
// Small seeded PRNG (mulberry32) so "given rng" behaviour is deterministic.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- VOCAB_WORDS integrity ----
ok("word bank is non-empty", VOCAB_WORDS.length > 0);
ok("every entry has a non-empty word + definition",
  VOCAB_WORDS.every((w) => typeof w.word === "string" && w.word &&
    typeof w.definition === "string" && w.definition));
check("all words are unique",
  new Set(VOCAB_WORDS.map((w) => w.word)).size, VOCAB_WORDS.length);
// Unique definitions are REQUIRED: distractors reuse other words' definitions,
// so a duplicate could make a "wrong" option equal the correct answer.
check("all definitions are unique",
  new Set(VOCAB_WORDS.map((w) => w.definition)).size, VOCAB_WORDS.length);

// ---- shuffleArr: pure (new array), same members ----
(function () {
  const src = [1, 2, 3, 4, 5];
  const out = shuffleArr(src, mulberry32(1));
  ok("shuffleArr returns a new array", out !== src);
  check("shuffleArr preserves length", out.length, src.length);
  check("shuffleArr keeps the same members",
    out.slice().sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  check("shuffleArr does not mutate the input", src, [1, 2, 3, 4, 5]);
})();

// ---- buildVocabQuiz: shape + counts ----
(function () {
  const q = buildVocabQuiz(VOCAB_WORDS, 8, mulberry32(42));
  check("requested count is honoured", q.length, 8);
  q.forEach((it, i) => {
    ok("q" + i + " has exactly 4 options", it.options.length === 4);
    ok("q" + i + " options are unique", new Set(it.options).size === 4);
    ok("q" + i + " options include the answer", it.options.indexOf(it.answer) >= 0);
    const src = VOCAB_WORDS.find((w) => w.word === it.word);
    ok("q" + i + " word comes from the bank", !!src);
    ok("q" + i + " answer is that word's definition", src && src.definition === it.answer);
  });
  // No word is asked twice in a single round.
  check("questions use distinct words",
    new Set(q.map((it) => it.word)).size, q.length);
})();

// ---- count is clamped to the bank size ----
check("count larger than bank clamps to bank size",
  buildVocabQuiz(VOCAB_WORDS, 999, mulberry32(7)).length, VOCAB_WORDS.length);
check("zero count yields no questions",
  buildVocabQuiz(VOCAB_WORDS, 0, mulberry32(7)).length, 0);

// ---- determinism: identical rng seed → identical quiz ----
(function () {
  const a = buildVocabQuiz(VOCAB_WORDS, 6, mulberry32(123));
  const b = buildVocabQuiz(VOCAB_WORDS, 6, mulberry32(123));
  check("same seed produces identical quiz",
    JSON.stringify(a), JSON.stringify(b));
})();

// ---- distractors are drawn from OTHER words' definitions ----
(function () {
  const mini = [
    { word: "aa", definition: "def-a" },
    { word: "bb", definition: "def-b" },
    { word: "cc", definition: "def-c" },
    { word: "dd", definition: "def-d" },
  ];
  const q = buildVocabQuiz(mini, 4, mulberry32(9));
  q.forEach((it, i) => {
    ok("mini q" + i + " has 4 options", it.options.length === 4);
    const wrong = it.options.filter((o) => o !== it.answer);
    ok("mini q" + i + " distractors are real other definitions",
      wrong.every((o) => mini.some((w) => w.definition === o && o !== it.answer)));
  });
})();

console.log("vocab-quest.test.js: " + passed + " assertions passed");
