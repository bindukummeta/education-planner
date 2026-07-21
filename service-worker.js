const CACHE = "eduplanner-v37";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./storage.js",
  "./schools-seed.js",
  "./sync-config.js",
  "./sync.js",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];
// Tesseract's engine + language model (~10–15 MB) are NOT precached — they are
// fetched on first use of the Homework Analyzer and then cached by the
// stale-while-revalidate handler below, so the shell stays lightweight.
// The supabase-js CDN bundle is also NOT precached: it's cross-origin and the
// fetch handler passes it straight through, so the app still boots offline
// (sync.js no-ops when window.supabase is undefined).

self.addEventListener("install", (event) => {
  // Pre-cache the shell. Do NOT skipWaiting here — the page decides when to
  // activate the new SW (via the "Update available" prompt) so it never swaps
  // out mid-session unexpectedly.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Let the page trigger activation of a waiting SW.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Cross-origin (e.g. postcodes.io) — pass straight through, no caching.
  if (url.origin !== self.location.origin) return;

  // Navigations / HTML → network-first: fresh when online, cache when offline.
  const isNavigation =
    req.mode === "navigate" ||
    (req.headers.get("accept") || "").includes("text/html");
  if (isNavigation) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then((c) => c || caches.match("./index.html"))
        )
    );
    return;
  }

  // Same-origin static assets → stale-while-revalidate: serve cache instantly,
  // refresh the cached copy in the background so the next load is current.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
