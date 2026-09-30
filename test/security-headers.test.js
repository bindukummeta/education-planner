"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
let passed = 0;
function ok(desc, cond) { assert.ok(cond, desc); passed++; }

const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const headers = vercel.headers.find((entry) => entry.source === "/(.*)");
const csp = headers.headers.find((item) => item.key === "Content-Security-Policy").value;
const scriptSrc = (csp.match(/script-src [^;]+/) || [""])[0];

ok("csp is present", csp.indexOf("default-src 'self'") !== -1);
ok("scripts are not inline and the CDN script is hash-pinned",
  scriptSrc.indexOf("unsafe-inline") === -1 &&
  scriptSrc.indexOf("https://cdn.jsdelivr.net") === -1 &&
  scriptSrc.indexOf("'sha384-GFr3yTh5lJznCbZfpTtXnwboFsxqtTQoeTZCRHhE0579KrRmlCzen5AA8ohaB5ug'") !== -1);
ok("frames are denied", csp.indexOf("frame-ancestors 'none'") !== -1);
ok("connections are limited", csp.indexOf("https://*.supabase.co") !== -1 && csp.indexOf("wss://*.supabase.co") !== -1 && csp.indexOf("https://api.postcodes.io") !== -1 && csp.indexOf("https://cdn.jsdelivr.net") === -1);
ok("nosniff referrer and permissions are set",
  headers.headers.some((item) => item.key === "X-Content-Type-Options" && item.value === "nosniff") &&
  headers.headers.some((item) => item.key === "Referrer-Policy" && item.value === "no-referrer") &&
  headers.headers.some((item) => item.key === "Permissions-Policy" && item.value.indexOf("camera=()") !== -1));
ok("supabase script is pinned with sri", html.indexOf("integrity=\"sha384-GFr3yTh5lJznCbZfpTtXnwboFsxqtTQoeTZCRHhE0579KrRmlCzen5AA8ohaB5ug\"") !== -1 && html.indexOf("@supabase/supabase-js@2.45.4") !== -1);
ok("the update script is external", html.indexOf("sw-boot.js") !== -1 && html.indexOf("<script>") === -1);

console.log("security-headers.test.js: " + passed + " assertions passed");
