/*
 * Guard test for iOS PWA safe-area layout regressions.
 *
 * There is no browser/DOM in this suite, so we can't measure real geometry.
 * Instead we assert the CSS *source* keeps the safe-area insets that stop
 * fixed-position chrome from sliding under the notch / status bar / home
 * indicator. This specifically guards the bug where the drawer's first nav
 * item (Dashboard) sat under the notch and was unclickable, because a
 * position:fixed element ignores the body's safe-area padding.
 *
 * Zero external dependencies — run with `npm test` or
 * `node test/layout-safe-area.test.js`.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const cssSrc = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");

let passed = 0;
function ok(desc, cond) { assert.ok(cond, desc); passed++; }

// Return the body of the FIRST rule whose selector text exactly matches
// `selector` (i.e. the "{ ... }" contents), or null if not found.
function ruleBody(selector) {
  // Match the selector only when it stands alone before "{" (so ".drawer"
  // does not also pick up ".drawer.open" / ".drawer-backdrop"). The leading
  // boundary allows whitespace so selectors preceded by a comment still match.
  const re = new RegExp("(^|[\\s,}])" + selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{");
  const m = cssSrc.match(re);
  if (!m) return null;
  const open = cssSrc.indexOf("{", m.index);
  const close = cssSrc.indexOf("}", open);
  return (open >= 0 && close > open) ? cssSrc.slice(open + 1, close) : null;
}

// ---- .drawer: the actual regression — must inset top AND bottom ----
(function () {
  const body = ruleBody(".drawer");
  ok(".drawer rule exists in styles.css", body != null);
  ok(".drawer is position:fixed (why insets are needed)", /position:\s*fixed/.test(body));
  ok(".drawer padding accounts for safe-area-inset-top (keeps Dashboard clear of the notch)",
    /padding:[^;]*env\(\s*safe-area-inset-top\s*\)/.test(body));
  ok(".drawer padding accounts for safe-area-inset-bottom (last item clears the home indicator)",
    /padding:[^;]*env\(\s*safe-area-inset-bottom\s*\)/.test(body));
})();

// ---- body: keeps the global safe-area insets it has always relied on ----
(function () {
  const body = ruleBody("body");
  ok("body rule exists in styles.css", body != null);
  ok("body still insets for the top safe area", /env\(\s*safe-area-inset-top\s*\)/.test(body));
  ok("body still insets for the bottom safe area", /env\(\s*safe-area-inset-bottom\s*\)/.test(body));
})();

// ---- .tabbar: bottom nav must clear the home indicator ----
(function () {
  const body = ruleBody(".tabbar");
  if (body == null) return; // tabbar is optional chrome; only assert if present
  ok(".tabbar padding accounts for safe-area-inset-bottom",
    /padding:[^;]*env\(\s*safe-area-inset-bottom\s*\)/.test(body));
})();

console.log("layout-safe-area.test.js: " + passed + " assertions passed");
