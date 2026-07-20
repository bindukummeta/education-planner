/*
 * Permanent test harness for the Spelling Wizard game's pure logic:
 *   SPELL_WORDS (word bank), pickSpellWords, buildSpellRound (which uses shuffleArr).
 *
 * app.js is a browser IIFE, so these aren't exported. As with the other game tests,
 * we slice the relevant source out of app.js and evaluate it in a vm sandbox, so the
 * test always exercises the REAL shipped code. Zero external dependencies — run with
 * `npm test` or `node test/spelling-wizard.test.js`.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// Slice 1: the SPELL_WORDS array literal (from its declaration to its closer).
const wordsStart = appSrc.indexOf("const SPELL_WORDS = [");
assert.ok(wordsStart >= 0, "could not find SPELL_WORDS in app.js");
const wordsClose = appSrc.indexOf("\n  ];", wordsStart);
assert.ok(wordsClose > wordsStart, "could not find end of SPELL_WORDS");
const wordsBlock = appSrc.slice(wordsStart, wordsClose + "\n  ];".length);

// Slice 2: shuffleArr (dependency of buildSpellRound), taken from the vocab section.
const shufStart = appSrc.indexOf("function shuffleArr(arr, rng) {");
const shufEnd = appSrc.indexOf("\n  // Weight a word", shufStart);
assert.ok(shufStart >= 0, "could not find shuffleArr in app.js");
assert.ok(shufEnd > shufStart, "could not find shuffleArr boundary in app.js");
const shufBlock = appSrc.slice(shufStart, shufEnd);

// Slice 3: the spelling constants + pure helpers (spellWeight, pickSpellWords,
// buildSpellRound), up to the async loadSpellMastery which touches EduStore.
const constStart = appSrc.indexOf("const SPELL_ROUND_LEN =");
const fnEnd = appSrc.indexOf("async function loadSpellMastery");
assert.ok(constStart >= 0, "could not find SPELL_ROUND_LEN in app.js");
assert.ok(fnEnd > constStart, "could not find loadSpellMastery boundary in app.js");
const spellBlock = appSrc.slice(constStart, fnEnd);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  wordsBlock + "\n" + shufBlock + "\n" + spellBlock +
    "\n;this.__x = { SPELL_WORDS, pickSpellWords, buildSpellRound };",
  sandbox,
  { filename: "app.js#spelling-wizard" }
);
const { SPELL_WORDS, pickSpellWords, buildSpellRound } = sandbox.__x;
assert.ok(Array.isArray(SPELL_WORDS), "SPELL_WORDS not extracted");
assert.strictEqual(typeof pickSpellWords, "function", "pickSpellWords not extracted");
assert.strictEqual(typeof buildSpellRound, "function", "buildSpellRound not extracted");

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

// ---- SPELL_WORDS integrity ----
ok("word bank is non-empty", SPELL_WORDS.length > 0);
ok("every entry has a non-empty word + hint",
  SPELL_WORDS.every((w) => typeof w.word === "string" && w.word &&
    typeof w.hint === "string" && w.hint));
check("all words are unique",
  new Set(SPELL_WORDS.map((w) => w.word)).size, SPELL_WORDS.length);
ok("words are lowercase letters only (tiles stay simple)",
  SPELL_WORDS.every((w) => /^[a-z]+$/.test(w.word)));

// ---- buildSpellRound: shape + counts ----
(function () {
  const r = buildSpellRound(SPELL_WORDS, 6, mulberry32(42));
  check("requested count is honoured", r.length, 6);
  r.forEach((it, i) => {
    const src = SPELL_WORDS.find((w) => w.word === it.word);
    ok("q" + i + " word comes from the bank", !!src);
    ok("q" + i + " hint is that word's hint", src && src.hint === it.hint);
    check("q" + i + " tiles length equals word length", it.tiles.length, it.word.length);
    // Tiles are the word's own letters, just reordered.
    check("q" + i + " tiles are the word's letters",
      it.tiles.slice().sort().join(""), it.word.split("").sort().join(""));
  });
  check("round uses distinct words",
    new Set(r.map((it) => it.word)).size, r.length);
})();

// ---- count is clamped to the bank size ----
check("count larger than bank clamps to bank size",
  buildSpellRound(SPELL_WORDS, 999, mulberry32(7)).length, SPELL_WORDS.length);
check("zero count yields no words",
  buildSpellRound(SPELL_WORDS, 0, mulberry32(7)).length, 0);

// ---- determinism: identical rng seed → identical round ----
(function () {
  const a = buildSpellRound(SPELL_WORDS, 5, mulberry32(123));
  const b = buildSpellRound(SPELL_WORDS, 5, mulberry32(123));
  check("same seed produces identical round",
    JSON.stringify(a), JSON.stringify(b));
})();

// ---- pickSpellWords: selection basics ----
(function () {
  const picked = pickSpellWords(SPELL_WORDS, {}, 6, mulberry32(3));
  check("pickSpellWords honours count", picked.length, 6);
  check("pickSpellWords returns distinct words",
    new Set(picked.map((w) => w.word)).size, picked.length);
  ok("pickSpellWords picks only bank words",
    picked.every((w) => SPELL_WORDS.some((b) => b.word === w.word)));
  check("pickSpellWords clamps to bank size",
    pickSpellWords(SPELL_WORDS, {}, 999, mulberry32(3)).length, SPELL_WORDS.length);
  check("pickSpellWords zero count yields none",
    pickSpellWords(SPELL_WORDS, {}, 0, mulberry32(3)).length, 0);
  const a = pickSpellWords(SPELL_WORDS, {}, 4, mulberry32(55));
  const b = pickSpellWords(SPELL_WORDS, {}, 4, mulberry32(55));
  check("pickSpellWords is deterministic given rng",
    a.map((w) => w.word).join(","), b.map((w) => w.word).join(","));
})();

// ---- mastered words appear far less often than new ones ----
(function () {
  const mastery = {};
  const mastered = SPELL_WORDS.slice(0, Math.floor(SPELL_WORDS.length / 2));
  mastered.forEach((w) => { mastery[w.word] = { seen: 5, correct: 5 }; });
  const masteredSet = new Set(mastered.map((w) => w.word));
  const rng = mulberry32(2024);
  let masteredHits = 0;
  const trials = 2000;
  for (let i = 0; i < trials; i++) {
    if (masteredSet.has(pickSpellWords(SPELL_WORDS, mastery, 1, rng)[0].word)) masteredHits++;
  }
  ok("mastered words are chosen much less than new ones (" +
    Math.round((masteredHits / trials) * 100) + "%)", masteredHits / trials < 0.2);
  ok("mastered words still surface occasionally", masteredHits > 0);
})();

console.log("spelling-wizard.test.js: " + passed + " assertions passed");
