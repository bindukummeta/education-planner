/*
 * Permanent test harness for the Homework Analyzer's pure heuristics:
 *   estimateComplexity(text, subject), guessTopic(text, subject), attemptOutcome(a).
 *
 * app.js is a browser IIFE, so these functions aren't exported. Rather than
 * duplicate them (and let a copy drift from the shipped code), we slice the
 * relevant source block out of app.js and evaluate it in a vm sandbox. The test
 * therefore always exercises the REAL functions. Zero external dependencies —
 * run with `npm test` or `node test/heuristics.test.js`.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// Slice from the AN_TOPIC_KEYWORDS dependency through the end of attemptOutcome.
const START = "const AN_TOPIC_KEYWORDS = {";
const END = "function attemptOutcome(a) {";
const startIdx = appSrc.indexOf(START);
const endMarkerIdx = appSrc.indexOf(END);
assert.ok(startIdx >= 0, "could not find AN_TOPIC_KEYWORDS in app.js");
assert.ok(endMarkerIdx > startIdx, "could not find attemptOutcome in app.js");
// Extend to the closing brace of attemptOutcome (first "}" after its body start).
const bodyOpen = appSrc.indexOf("{", endMarkerIdx);
const bodyClose = appSrc.indexOf("\n  }", bodyOpen); // matches the 2-space-indented closer
assert.ok(bodyClose > bodyOpen, "could not find end of attemptOutcome body");
const block = appSrc.slice(startIdx, bodyClose + "\n  }".length);

// Evaluate the extracted block, then expose the three functions.
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  block + "\n;this.__fns = { estimateComplexity, guessTopic, attemptOutcome };",
  sandbox,
  { filename: "app.js#heuristics" }
);
const { estimateComplexity, guessTopic, attemptOutcome } = sandbox.__fns;
assert.strictEqual(typeof estimateComplexity, "function", "estimateComplexity not extracted");
assert.strictEqual(typeof guessTopic, "function", "guessTopic not extracted");
assert.strictEqual(typeof attemptOutcome, "function", "attemptOutcome not extracted");

let passed = 0;
function check(desc, actual, expected) {
  assert.deepStrictEqual(actual, expected, desc + " (got " + JSON.stringify(actual) + ")");
  passed++;
}

// ---- estimateComplexity: deterministic, clamped 1..5 ----
check("empty text defaults to 2", estimateComplexity("", "maths"), 2);
check("whitespace-only defaults to 2", estimateComplexity("   ", "maths"), 2);
check("short simple prompt scores 1", estimateComplexity("Add these", "maths"), 1);
check("long prompt gains length points",
  estimateComplexity("one two three four five six seven eight nine ten", "english"), 2);
check("reasoning keyword adds a point",
  estimateComplexity("Explain your answer", "english"), 2);
check("maths: many numbers + chained ops climb the scale",
  estimateComplexity("12 + 34 + 56 + 7", "maths"), 3);
check("maths word-problem phrasing adds a point",
  estimateComplexity("How many are left altogether?", "maths"), 2);
check("score is clamped to a max of 5",
  estimateComplexity(
    "Explain why 12 + 34 × 5 ÷ 6 − 7 altogether in total how many words words words words words words words words words words",
    "maths"
  ), 5);
check("non-maths subject ignores maths-only signals",
  estimateComplexity("1 + 2 + 3", "english"), 1);
// Determinism: identical input → identical output.
check("deterministic across calls",
  estimateComplexity("How much change altogether from 3 + 4?", "maths"),
  estimateComplexity("How much change altogether from 3 + 4?", "maths"));

// ---- guessTopic: first matching keyword row wins; "" when nothing matches ----
check("detects fractions", guessTopic("What is the numerator?", "maths"), "fractions");
check("detects percentages", guessTopic("Find 20 percent of 50", "maths"), "percentages");
check("detects geometry", guessTopic("Measure this angle", "maths"), "geometry");
check("detects money via symbol", guessTopic("It costs £3", "maths"), "money");
check("unknown maths text returns empty string", guessTopic("hello there", "maths"), "");
check("subject with no keyword table returns empty string",
  guessTopic("Add these numbers", "english"), "");
check("empty text returns empty string", guessTopic("", "maths"), "");

// ---- attemptOutcome: marks → outcome mapping ----
check("full marks → correct", attemptOutcome({ marksAwarded: 2, marksAvailable: 2 }), "correct");
check("over-full marks → correct", attemptOutcome({ marksAwarded: 3, marksAvailable: 2 }), "correct");
check("zero marks → incorrect", attemptOutcome({ marksAwarded: 0, marksAvailable: 2 }), "incorrect");
check("partial marks → partial", attemptOutcome({ marksAwarded: 1, marksAvailable: 2 }), "partial");
check("null awarded → unmarked", attemptOutcome({ marksAwarded: null, marksAvailable: 2 }), "unmarked");
check("null available → unmarked", attemptOutcome({ marksAwarded: 1, marksAvailable: null }), "unmarked");
check("missing fields → unmarked", attemptOutcome({}), "unmarked");
check("zero-available guard → unmarked", attemptOutcome({ marksAwarded: 0, marksAvailable: 0 }), "unmarked");
check("negative available guard → unmarked", attemptOutcome({ marksAwarded: 1, marksAvailable: -1 }), "unmarked");

console.log("heuristics.test.js: " + passed + " assertions passed");
