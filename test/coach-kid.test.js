"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const start = appSrc.indexOf("// __COACHKID_START__");
const end = appSrc.indexOf("// __COACHKID_END__");
assert.ok(start >= 0, "no __COACHKID_START__"); assert.ok(end > start, "no __COACHKID_END__");
const block = appSrc.slice(start, end);
const sandbox = {}; vm.createContext(sandbox);
vm.runInContext(block +
  "\n;this.__x = { kidMasterySummary, kidGameBucket, kidNextSteps, kidCheer, KID_CHEERS };",
  sandbox, { filename: "app.js#coachkid" });
const { kidMasterySummary, kidGameBucket, kidNextSteps, kidCheer, KID_CHEERS } = sandbox.__x;
// AI_BANNED copied from app.js (kept in sync manually):
const AI_BANNED = ["weak","weakest","worst","bad","poor","behind","lazy","failing","fail",
  "stupid","dumb","slow","genius","gifted","talented"];
const GAMES = [
  { title: "Vocabulary Quest", icon: "📖", skillSubject: "vr" },
  { title: "Number Ninja", icon: "🥷", skillSubject: "maths" },
  { title: "Spelling Wizard", icon: "🔤", skillSubject: "english" },
  { title: "Pattern Detective", icon: "🧩", skillSubject: "nvr" },
];
let passed = 0;
function check(d,a,e){assert.strictEqual(JSON.stringify(a),JSON.stringify(e),d);passed++;}
function ok(d,c){assert.ok(c,d);passed++;}

// empty maps → zero tallies
check("empty summary", kidMasterySummary({},{},{},{vocab:2,ninja:6,spell:2}),
  { vocab:{mastered:0,practising:0}, ninja:{mastered:0,practising:0}, spell:{mastered:0,practising:0} });
// tally respects thresholds
check("ninja tally", kidMasterySummary({}, {add:{seen:9,correct:6}, divide:{seen:3,correct:1}}, {},
  {vocab:2,ninja:6,spell:2}).ninja, { mastered:1, practising:1 });
// bucket mapping
check("vr→vocab", kidGameBucket("vr"), "vocab");
check("nvr→null", kidGameBucket("nvr"), null);
// empty maps → safe generic suggestions, capped at 3, no focus line
(function(){ const s = kidNextSteps(null, kidMasterySummary({},{},{},{}), GAMES, 3);
  check("cap 3", s.length, 3);
  ok("generic lines", s.every(x => x.line.indexOf("Try a round of") === 0)); })();
// practising items prioritise the right game
(function(){ const sum = kidMasterySummary({}, {add:{correct:0},sub:{correct:0}}, {}, {ninja:6});
  const s = kidNextSteps(null, sum, GAMES, 3);
  ok("Number Ninja first (most practising)", s[0].gameTitle === "Number Ninja"); })();
// focus subject's game appears first even with fewer practising items
(function(){ const sum = kidMasterySummary({word:{correct:0}}, {}, {}, {vocab:2});
  const s = kidNextSteps({subject:"maths"}, sum, GAMES, 3);
  ok("focus game present", s.some(x => x.gameTitle === "Number Ninja"));
  ok("focus game first", s[0].gameTitle === "Number Ninja"); })();
// SAFETY: no generated line contains any banned word
(function(){ const sum = kidMasterySummary({a:{correct:0}}, {add:{correct:0}}, {b:{correct:0}}, {vocab:2,ninja:6,spell:2});
  const lines = kidNextSteps({subject:"english"}, sum, GAMES, 3).map(x => x.line).concat(KID_CHEERS);
  lines.forEach(function(l){ const lc = l.toLowerCase();
    AI_BANNED.forEach(function(w){ ok("no banned '"+w+"' in: "+l, !new RegExp("\\b"+w+"\\b").test(lc)); }); }); })();
// kidCheer deterministic with seeded rng
check("kidCheer picks index 0", kidCheer(() => 0), KID_CHEERS[0]);

console.log("coach-kid.test.js: " + passed + " assertions passed");
