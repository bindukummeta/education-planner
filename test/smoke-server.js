"use strict";
// Local static server for browser smoke tests. It binds to loopback only and
// does not call Supabase, Anthropic, or any other network service.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const HOST = "127.0.0.1";
const PORT = Number(process.env.SMOKE_PORT || 4173);
const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

function send(res, status, body, type) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    "content-type": type || "text/plain; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
  });
  res.end(payload);
}

function resolveFile(pathname) {
  let rel = pathname;
  try { rel = decodeURIComponent(pathname); } catch (_) { return null; }
  if (rel.indexOf("\0") !== -1) return null;
  if (rel === "/") rel = "/index.html";
  const parts = rel.split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part === ".git" || part === "node_modules" || part === ".env")) return null;
  const file = path.resolve(ROOT, parts.join(path.sep));
  if (file !== ROOT && file.indexOf(rootWithSep) !== 0) return null;
  return file;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/health") return send(res, 200, "ok");
  if (url.pathname === "/api/public-config") {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method");
    const body = JSON.stringify({
      ok: true,
      environment: "local",
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key-0123456789abcdef",
      clientReports: false,
    });
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      return res.end();
    }
    return send(res, 200, body, "application/json; charset=utf-8");
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method");
  const file = resolveFile(url.pathname);
  if (!file) return send(res, 400, "bad path");
  fs.stat(file, (statErr, stat) => {
    if (statErr || !stat.isFile()) return send(res, 404, "not found");
    const type = TYPES[path.extname(file)] || "application/octet-stream";
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-type": type, "content-length": stat.size, "cache-control": "no-store" });
      return res.end();
    }
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, "not found");
      send(res, 200, buf, type);
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log("SMOKE_READY http://" + HOST + ":" + PORT);
});
