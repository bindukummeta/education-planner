/*
 * Permanent test harness for the Vocabulary Quest game's pure logic:
 *   VOCAB_WORDS (word bank), shuffleArr, pickVocabWords, buildVocabQuiz.
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

// Slice 2: the pure helpers (shuffleArr, vocabWeight, pickVocabWords,
// buildVocabQuiz) — contiguous, up to the async loadVocabMastery which touches
// EduStore and isn't pure. We also need the two mastery constants they read.
const constStart = appSrc.indexOf("const VOCAB_QUIZ_LEN =");
const fnStart = appSrc.indexOf("function shuffleArr(arr, rng) {");
const fnEnd = appSrc.indexOf("async function loadVocabMastery");
assert.ok(constStart >= 0, "could not find VOCAB_QUIZ_LEN in app.js");
assert.ok(fnStart >= 0, "could not find shuffleArr in app.js");
assert.ok(fnEnd > fnStart, "could not find loadVocabMastery boundary in app.js");
const constBlock = appSrc.slice(constStart, fnStart);
const fnBlock = appSrc.slice(fnStart, fnEnd);

// Evaluate both slices together, then expose what we need.
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  wordsBlock + "\n" + constBlock + "\n" + fnBlock +
    "\n;this.__x = { VOCAB_WORDS, shuffleArr, pickVocabWords, buildVocabQuiz };",
  sandbox,
  { filename: "app.js#vocab-quest" }
);
const { VOCAB_WORDS, shuffleArr, pickVocabWords, buildVocabQuiz } = sandbox.__x;
assert.ok(Array.isArray(VOCAB_WORDS), "VOCAB_WORDS not extracted");
assert.strictEqual(typeof shuffleArr, "function", "shuffleArr not extracted");
assert.strictEqual(typeof pickVocabWords, "function", "pickVocabWords not extracted");
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

// ---- pickVocabWords: mastery-weighted selection ----
(function () {
  // Requested count, distinct words, all from the bank.
  const picked = pickVocabWords(VOCAB_WORDS, {}, 8, mulberry32(3));
  check("pickVocabWords honours count", picked.length, 8);
  check("pickVocabWords returns distinct words",
    new Set(picked.map((w) => w.word)).size, picked.length);
  ok("pickVocabWords picks only bank words",
    picked.every((w) => VOCAB_WORDS.some((b) => b.word === w.word)));

  // Count clamps to bank size; zero yields none.
  check("pickVocabWords clamps to bank size",
    pickVocabWords(VOCAB_WORDS, {}, 999, mulberry32(3)).length, VOCAB_WORDS.length);
  check("pickVocabWords zero count yields none",
    pickVocabWords(VOCAB_WORDS, {}, 0, mulberry32(3)).length, 0);

  // Determinism: same seed + mastery → identical selection.
  const a = pickVocabWords(VOCAB_WORDS, {}, 6, mulberry32(55));
  const b = pickVocabWords(VOCAB_WORDS, {}, 6, mulberry32(55));
  check("pickVocabWords is deterministic given rng",
    a.map((w) => w.word).join(","), b.map((w) => w.word).join(","));
})();

// ---- mastered words appear far less often than new ones ----
(function () {
  // Mark half the bank as mastered (correct >= 2). Over many single-word picks,
  // mastered words should be chosen much less than un-mastered ones.
  const mastery = {};
  const mastered = VOCAB_WORDS.slice(0, Math.floor(VOCAB_WORDS.length / 2));
  mastered.forEach((w) => { mastery[w.word] = { seen: 5, correct: 5 }; });
  const masteredSet = new Set(mastered.map((w) => w.word));

  const rng = mulberry32(2024);
  let masteredHits = 0;
  const trials = 2000;
  for (let i = 0; i < trials; i++) {
    const pick = pickVocabWords(VOCAB_WORDS, mastery, 1, rng)[0];
    if (masteredSet.has(pick.word)) masteredHits++;
  }
  // Half the words are mastered, so an unweighted picker would hit ~50%.
  // Mastered words weigh far less than new ones, so expect well under 20%.
  ok("mastered words are chosen much less than new ones (" +
    Math.round((masteredHits / trials) * 100) + "%)",
    masteredHits / trials < 0.2);
  // ...but they are NOT retired completely — they still surface occasionally.
  ok("mastered words still surface occasionally", masteredHits > 0);
})();

// ---- buildVocabQuiz with mastery favours un-mastered words ----
(function () {
  // With only 4 words un-mastered and asking for 4, the round should be exactly
  // those 4 (the mastered ones weigh far less and won't crowd them out).
  const mastery = {};
  VOCAB_WORDS.forEach((w, i) => {
    if (i >= 4) mastery[w.word] = { seen: 9, correct: 9 };
  });
  const fresh = new Set(VOCAB_WORDS.slice(0, 4).map((w) => w.word));
  let freshSlots = 0;
  const rounds = 300;
  for (let s = 0; s < rounds; s++) {
    const q = buildVocabQuiz(VOCAB_WORDS, 4, mulberry32(s), mastery);
    freshSlots += q.filter((it) => fresh.has(it.word)).length;
  }
  // With 4 un-mastered words weighing far more than the rest, the great majority
  // of the 4 question slots per round should be filled by those un-mastered words.
  const freshRatio = freshSlots / (rounds * 4);
  ok("mastery-built rounds are dominated by un-mastered words (" +
    Math.round(freshRatio * 100) + "%)", freshRatio > 0.7);
})();

console.log("vocab-quest.test.js: " + passed + " assertions passed");
