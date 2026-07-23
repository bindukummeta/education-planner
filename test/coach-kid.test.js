"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const start = appSrc.indexOf("// __COACHKID_START__");
const end = appSrc.indexOf("// __COACHKID_END__");
assert.ok(start >= 0, "no __COACHKID_START__"); assert.ok(end > start, "no __COACHKID_END__");
const block = appSrc.slice(start, end);
const sandbox = {}; vm.createContext(sandbox);
vm.runInContext(block +
  "\n;this.__x = { kidMasterySummary, kidGameBucket, kidNextSteps, kidCheer, KID_CHEERS," +
  " kidInterests, kidProjectsSummary, kidSparkLine };",
  sandbox, { filename: "app.js#coachkid" });
const { kidMasterySummary, kidGameBucket, kidNextSteps, kidCheer, KID_CHEERS,
  kidInterests, kidProjectsSummary, kidSparkLine } = sandbox.__x;
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

// ---- kidInterests ----
const TOPIC_LABELS = { space: "Space", science: "Science", nature: "Nature" };
const SUBJ_LABELS = { maths: "Maths", english: "English", vr: "VR" };
// empty rows → empty interests
check("interests empty", kidInterests([], TOPIC_LABELS, SUBJ_LABELS),
  { topTopics: [], topSubject: null, favouriteKind: null, total: 0 });
// counts topics/subjects/kinds, child-only, top subject is raw key, labels mapped
(function(){
  const rows = [
    { author: "child", kind: "question", topic: "space", subject: "maths" },
    { author: "child", kind: "question", topic: "space", subject: "maths" },
    { author: "child", kind: "observation", topic: "nature", subject: "english" },
    { author: "parent", kind: "question", topic: "science", subject: "vr" }, // excluded
  ];
  const i = kidInterests(rows, TOPIC_LABELS, SUBJ_LABELS);
  check("interests total child-only", i.total, 3);
  check("interests topTopic label", i.topTopics[0], "Space");
  check("interests topSubject raw key", i.topSubject, "maths");
  check("interests favouriteKind", i.favouriteKind, "question");
})();
// topTopics capped at 3
(function(){
  const rows = ["a","b","c","d"].map((t) => ({ author: "child", topic: t }));
  ok("topTopics capped at 3", kidInterests(rows, {}, {}).topTopics.length === 3);
})();

// ---- kidProjectsSummary ----
check("projects empty", kidProjectsSummary([], 1000),
  { recentCount: 0, topSkills: [], avgEnjoyment: null, latest: [] });
(function(){
  const now = 100 * 86400000;
  const projects = [
    { name: "Game", category: "Roblox Studio", createdAt: now - 5 * 86400000, skills: ["animation","code"], enjoyment: 5 },
    { name: "Story", category: "Scratch", createdAt: now - 40 * 86400000, skills: ["code"], enjoyment: 3 },
  ];
  const s = kidProjectsSummary(projects, now);
  check("projects recentCount (30d)", s.recentCount, 1);
  check("projects topSkill", s.topSkills[0], "code");
  check("projects avgEnjoyment rounded", s.avgEnjoyment, 4);
  check("projects latest name", s.latest[0].name, "Game");
})();

// ---- kidNextSteps interest boosting ----
(function(){
  // no focus, no practising, but interestSubject=maths → Number Ninja first
  const s = kidNextSteps(null, kidMasterySummary({},{},{},{}), GAMES, 3, "maths");
  ok("interest game first", s[0].gameTitle === "Number Ninja");
  ok("interest line framing", s[0].line.indexOf("matches what you love") >= 0);
})();
(function(){
  // focus still beats interest
  const s = kidNextSteps({subject:"english"}, kidMasterySummary({},{},{},{}), GAMES, 3, "maths");
  ok("focus beats interest", s[0].gameTitle === "Spelling Wizard");
})();

// ---- kidSparkLine ----
check("spark topic+book", kidSparkLine("Space", "Matilda"),
  "You've been wondering about Space and reading “Matilda” — here's an adventure! 🌟");
check("spark topic only", kidSparkLine("Space", ""),
  "You've been wondering about Space — here's an adventure! 🌟");
check("spark book only", kidSparkLine("", "Matilda"),
  "Loved reading “Matilda”? Here's your next adventure! 🌟");
check("spark none", kidSparkLine("", ""), "");

// SAFETY: interest-framed lines + spark lines contain no banned word
(function(){
  const lines = kidNextSteps(null, kidMasterySummary({},{},{},{}), GAMES, 3, "maths")
    .map((x) => x.line)
    .concat([kidSparkLine("Space", "Matilda"), kidSparkLine("Space", ""), kidSparkLine("", "Matilda")]);
  lines.forEach(function(l){ const lc = l.toLowerCase();
    AI_BANNED.forEach(function(w){ ok("no banned '"+w+"' in: "+l, !new RegExp("\\b"+w+"\\b").test(lc)); }); });
})();

console.log("coach-kid.test.js: " + passed + " assertions passed");
